// src/runtime/actionJobWorker.js
//
// Background loop: picks up pending action_jobs, runs the action, retries with
// exponential backoff, fires __SK_ACTION_FAILED.{name} on exhaustion.
//
// Delivery guarantees (docs/side-effects.md). The hard case is an attempt that was
// SENT but never answered — the server crashed mid-call, or the call timed out.
// Nobody knows whether the side effect happened, so each action declares what to do:
//
//   idempotent    run it again; the implementation dedupes on the job id
//                 (sent as `Idempotency-Key`, and as meta.jobId to local functions)
//   verify        first ask the implementation "did job X happen?" — done → keep its
//                 answer; not done → run; nobody knows → human review
//   at-most-once  (default) never repeat: mark the job 'unknown', send
//                 __SK_ACTION_UNKNOWN.{name} to the actor, wait for a human
//                 (GET /v1/action-jobs, POST /v1/action-jobs/:id/resolve)
//
// To know an attempt was sent, `started_at` is committed BEFORE the call. Errors that
// prove nothing was sent (connection refused, HTTP 4xx, a local function throwing)
// clear it and are retried in every mode. An action's follow-up event is delivered
// with idempotency key `job:<id>`, so it lands exactly once even across crashes.

import {
  claimActionJobs, markActionJobDone, markActionJobFailed, markActionJobStarted, markActionJobSucceeded,
  retryActionJobAfter, markActionJobUnknown, renewActionJobLeases, ACTION_JOB_LEASE_MS,
} from '../registry/actionJobRepo.js';
import { decrypt, encrypt } from '../registry/db.js';
import { getGlobalRegistry } from './implementationRegistry.js';
import { withRemote, remoteEnabled, refreshRemoteManifest } from './remoteImplementations.js';

const POLL_MS    = 1_000;
const MAX_ACTIVE = 50;
let _sendEvent = null;        // (actorId, event, { idempotencyKey, mergePayload }) => Promise
let _registry  = null;
let _stopped   = false;
let _timer     = null;
let _leaseTimer = null;
const active   = new Set();   // job ids being worked on by this process
const actorBusy = new Set();  // one job per actor at a time keeps an actor's actions in order

export function startActionJobWorker(sendEventFn, registry) {
  _sendEvent = sendEventFn;
  _registry  = registry;
  _stopped   = false;
  _timer     = setTimeout(runLoop, POLL_MS);
  // Keep leases of long-running actions alive so no other poll claims them again.
  _leaseTimer = setInterval(() => {
    renewActionJobLeases([...active], Date.now() + ACTION_JOB_LEASE_MS)
      .catch((e) => console.error('[actionJobWorker] lease renewal:', e.message));
  }, Math.max(250, Math.floor(ACTION_JOB_LEASE_MS / 3)));
  _leaseTimer.unref?.();
}

export function stopActionJobWorker() {
  _stopped = true;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_leaseTimer) { clearInterval(_leaseTimer); _leaseTimer = null; }
}

async function runLoop() {
  if (_stopped) return;
  try {
    const room = MAX_ACTIVE - active.size;
    const jobs = room > 0 ? await claimActionJobs(room) : [];
    for (const job of jobs) {
      if (actorBusy.has(job.actor_id)) {        // keep per-actor order: hand it back for the next poll
        await retryActionJobAfter(job.id, job.retry_count ?? 0, Date.now(), { sent: job.started_at != null }).catch(() => {});
        continue;
      }
      active.add(job.id); actorBusy.add(job.actor_id);
      processJob(job)
        .catch((e) => console.error('[actionJobWorker] job error:', e.message))
        .finally(() => { active.delete(job.id); actorBusy.delete(job.actor_id); });
    }
  } catch (err) {
    console.error('[actionJobWorker] loop error:', err.message);
  }
  if (!_stopped) _timer = setTimeout(runLoop, POLL_MS);
}

const snap = (buf) => {
  if (!buf) return null;
  try { return JSON.parse(decrypt(Buffer.from(buf)).toString('utf8')); } catch { return null; }
};

/** Deliver the action's follow-up event (if any) exactly once, then finish the job. */
async function complete(job, answer) {
  const send = answer && typeof answer === 'object' ? answer.send : null;
  if (send && typeof send.type === 'string' && _sendEvent) {
    await _sendEvent(job.actor_id, send, { idempotencyKey: `job:${job.id}`, mergePayload: send });
  }
  await markActionJobDone(job.id);
}

async function unknownOutcome(job, reason) {
  console.warn(`[actionJobWorker] '${job.action_name}' job ${job.id}: outcome unknown (${reason}) — needs review`);
  await markActionJobUnknown(job.id);
  if (_sendEvent) {
    await _sendEvent(job.actor_id, { type: `__SK_ACTION_UNKNOWN.${job.action_name}`, jobId: job.id, reason },
      { idempotencyKey: `unknown:${job.id}`, mergePayload: null }).catch(() => {});
  }
}

async function processJob(job) {
  if (remoteEnabled()) await refreshRemoteManifest();
  const fn = withRemote(getGlobalRegistry() ?? _registry)?.actions?.[job.action_name];
  if (!fn) {
    console.warn(`[actionJobWorker] No action fn for '${job.action_name}' — marking failed`);
    await markActionJobFailed(job.id).catch(() => {});
    return;
  }
  const opts     = fn.__sk_durable ?? {};
  const delivery = opts.delivery ?? 'at-most-once';
  const actualFn = opts.originalFn ?? fn;
  const context  = snap(job.context_snap) ?? {};
  const event    = snap(job.event_snap) ?? {};
  const meta     = { actorId: job.actor_id, jobId: job.id, key: job.id };

  // 1. The action already succeeded earlier; only its follow-up delivery is pending.
  if (job.outcome === 'succeeded') return complete(job, snap(job.result_snap));

  // 2. An earlier attempt was sent and never answered.
  if (job.started_at != null) {
    if (delivery === 'at-most-once') return unknownOutcome(job, 'an earlier attempt was sent but never answered');
    if (delivery === 'verify') {
      let status;
      try { status = await opts.verify({ context, event }, meta); }
      catch (err) { return retryLater(job, opts, err, { sent: true }); }       // ask again later
      if (status?.done === true) {
        await markActionJobSucceeded(job.id, encrypt(Buffer.from(JSON.stringify(status))));
        return complete(job, status);
      }
      if (status?.running === true) {                                        // still executing: check again soon
        return retryActionJobAfter(job.id, job.retry_count ?? 0, Date.now() + 1000, { sent: true });
      }
      if (status?.done !== false) return unknownOutcome(job, 'the implementation cannot tell whether it happened');
      // done === false: it certainly did not happen → run it
    }
    // idempotent (or verified not done): run again with the same job id
  }

  // 3. Attempt. Record "sent" durably BEFORE sending.
  await markActionJobStarted(job.id);
  let answer;
  try {
    answer = await actualFn({ context, event }, meta);
  } catch (err) {
    // Remote errors say whether the request may have been processed; a local function
    // that throws is reporting that it did not complete.
    const sent = opts.remote ? err.sent !== false : false;
    if (sent && delivery === 'at-most-once') return unknownOutcome(job, err.message);
    return retryLater(job, opts, err, { sent });
  }
  await markActionJobSucceeded(job.id, answer ? encrypt(Buffer.from(JSON.stringify(answer))) : null);
  return complete(job, answer);
}

async function retryLater(job, opts, err, { sent }) {
  const newRetryCount = (job.retry_count ?? 0) + 1;
  const maxRetries    = opts.maxRetries ?? job.max_retries ?? 3;
  if (newRetryCount >= maxRetries) {
    if (sent && (opts.delivery ?? 'at-most-once') !== 'idempotent') {
      return unknownOutcome(job, `gave up after ${newRetryCount} attempts: ${err.message}`);
    }
    await markActionJobFailed(job.id).catch(() => {});
    if (_sendEvent) {
      await _sendEvent(job.actor_id, { type: `__SK_ACTION_FAILED.${job.action_name}`, data: { error: err.message } },
        { idempotencyKey: `failed:${job.id}`, mergePayload: null }).catch(() => {});
    }
    return;
  }
  // Exponential backoff: 1s, 2s, 4s, …, capped at 5 minutes
  const backoffMs = Math.min(1000 * 2 ** (newRetryCount - 1), 300_000);
  await retryActionJobAfter(job.id, newRetryCount, Date.now() + backoffMs, { sent }).catch(() => {});
}
