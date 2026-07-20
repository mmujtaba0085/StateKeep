// src/runtime/actionJobWorker.js
//
// Background loop: picks up pending action_jobs, runs the function, retries with
// exponential backoff. Fires __SK_ACTION_FAILED.{name} on exhaustion.

import { claimActionJobs, markActionJobDone, retryActionJob, markActionJobFailed }
  from '../registry/actionJobRepo.js';
import { decrypt } from '../registry/db.js';
import { getGlobalRegistry } from './implementationRegistry.js';

const POLL_MS  = 1_000;
let _sendEvent = null;
let _registry  = null;
let _stopped   = false;
let _timer     = null;

export function startActionJobWorker(sendEventFn, registry) {
  _sendEvent = sendEventFn;
  _registry  = registry;
  _stopped   = false;
  _timer     = setTimeout(runLoop, POLL_MS);
}

export function stopActionJobWorker() {
  _stopped = true;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

async function runLoop() {
  if (_stopped) return;
  try {
    const jobs = await claimActionJobs(50);
    for (const job of jobs) {
      await processJob(job);
    }
  } catch (err) {
    console.error('[actionJobWorker] loop error:', err.message);
  }
  if (!_stopped) _timer = setTimeout(runLoop, POLL_MS);
}

async function processJob(job) {
  const fn = (getGlobalRegistry() ?? _registry)?.actions?.[job.action_name];
  if (!fn) {
    console.warn(`[actionJobWorker] No action fn for '${job.action_name}' — marking failed`);
    await markActionJobFailed(job.id).catch(() => {});
    return;
  }

  let context = {};
  if (job.context_snap) {
    try { context = JSON.parse(decrypt(Buffer.from(job.context_snap)).toString('utf8')); } catch {}
  }
  let event = {};
  if (job.event_snap) {
    try { event = JSON.parse(decrypt(Buffer.from(job.event_snap)).toString('utf8')); } catch {}
  }

  try {
    const actualFn = fn.__sk_durable ? fn.__sk_durable.originalFn : fn;
    await actualFn({ context, event }, {});
    await markActionJobDone(job.id).catch(() => {});
  } catch (err) {
    const newRetryCount = (job.retry_count ?? 0) + 1;
    const opts          = fn.__sk_durable ?? {};
    const maxRetries    = opts.maxRetries ?? job.max_retries ?? 3;

    if (newRetryCount >= maxRetries) {
      await markActionJobFailed(job.id).catch(() => {});
      // Fire __SK_ACTION_FAILED.{name} to the actor
      if (_sendEvent) {
        await _sendEvent(job.actor_id, { type: `__SK_ACTION_FAILED.${job.action_name}`, data: { error: err.message } })
          .catch(() => {});
      }
    } else {
      // Exponential backoff: 1s, 2s, 4s, …, capped at 5 minutes (first retry = 2^0 = 1s)
      const backoffMs = Math.min(1000 * 2 ** (newRetryCount - 1), 300_000);
      await retryActionJob(job.id, newRetryCount, Date.now() + backoffMs).catch(() => {});
    }
  }
}
