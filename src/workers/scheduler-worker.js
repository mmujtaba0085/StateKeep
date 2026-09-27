/**
 * src/workers/scheduler-worker.js
 *
 * Background process: fires scheduled_events whose fire_at <= now.
 * Polls every 5 s. Each event is marked fired/failed atomically before
 * the engine call so duplicate delivery is impossible even if the process
 * crashes mid-loop.
 *
 * Skips actors that are terminated, archived, or needs_rescue.
 */

import { getDb, encrypt, isPostgres } from '../registry/db.js';
import { findDueEvents, markFired, markDispatchFailed, scheduleRetryOrFail, retryScheduledEventSoon, cancelScheduledEventById } from '../registry/scheduledEventRepo.js';
import { startHeartbeat } from './heartbeat.js';
import { findActorById } from '../registry/actorRepo.js';
import { getEngine, engineReady } from '../ffi/engine.js';

const POLL_INTERVAL = parseInt(process.env.SCHEDULER_POLL_INTERVAL ?? '5000', 10);
const SKIP_STATUSES = new Set(['terminated', 'archived', 'needs_rescue']);
const FINISHED      = new Set(['terminated', 'archived']);
const UNREACHABLE_RETRY_MS = parseInt(process.env.SCHEDULER_UNREACHABLE_RETRY_MS ?? '2000', 10);

// Where the API server listens for internal calls from workers.
const INTERNAL_URL = process.env.STATEKEEP_INTERNAL_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3001}`;
const ADMIN_KEY    = process.env.STATEKEEP_ADMIN_KEY ?? '';

console.log('[scheduler-worker] Starting...');

await engineReady;

if (isPostgres) {
  const { bootstrapSchema } = await import('../registry/db-postgres.js');
  await bootstrapSchema();
} else {
  getDb();
}

startHeartbeat('scheduler');

async function tick() {
  const now  = Date.now();
  const rows = await findDueEvents(now);

  for (const row of rows) {
    // Check actor before claiming — retry or permanently fail if actor is gone/terminal
    const actor = await findActorById(row.actorId ?? row.actor_id);
    if (!actor || SKIP_STATUSES.has(actor.status)) {
      const reason = `actor ${actor ? actor.status : 'not found'}`;
      // A finished actor never needs its timer again; only a stranded one may come back.
      if (actor && FINISHED.has(actor.status)) await cancelScheduledEventById(row.id, reason);
      else await scheduleRetryOrFail(row, reason);
      continue;
    }

    // Claim atomically — markFired returns 0 if another worker beat us
    const claimed = await markFired(row.id, now);
    if (!claimed) continue;

    try {
      const eng       = getEngine();
      const clockTick = eng.available ? Number(eng.clockTick()) : Date.now();
      // payload must not override the event type
      const event     = { ...(row.payload ?? {}), type: row.eventType ?? row.event_type };

      // Deliver through the API server (the single owner of the actor cache) — see
      // /v1/internal/actors/:id/dispatch. Calling sendEvent() here left the server's
      // cached copy stale and let a later API event overwrite the fired transition.
      const res = await fetch(`${INTERNAL_URL}/v1/internal/actors/${encodeURIComponent(row.actorId ?? row.actor_id)}/dispatch`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...(ADMIN_KEY ? { 'x-admin-key': ADMIN_KEY } : {}) },
        // idempotencyKey: the fired timer is recorded in the actor's history (same commit
        // as its transition) and a retry after a crash cannot fire it twice
        body:    JSON.stringify({ event, tick: clockTick, idempotencyKey: `timer:${row.id}` }),
        signal:  AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw Object.assign(new Error(`dispatch failed: HTTP ${res.status} ${body.slice(0, 200)}`), { status: res.status, body });
      }

      // Write SCHEDULED_EVENT_FIRED to event log
      const encPayload = row.payload
        ? encrypt(Buffer.from(JSON.stringify(row.payload)))
        : null;

      if (isPostgres) {
        const { query } = await import('../registry/db-postgres.js');
        await query(
          `INSERT INTO events (actor_id, event_type, event_payload, tick, processed_at) VALUES ($1,'SCHEDULED_EVENT_FIRED',$2,$3,$4)`,
          [row.actorId ?? row.actor_id, encPayload, clockTick, now]
        );
      } else {
        getDb().prepare(
          `INSERT INTO events (actor_id, event_type, event_payload, tick, processed_at) VALUES (?, 'SCHEDULED_EVENT_FIRED', ?, ?, ?)`
        ).run(row.actorId ?? row.actor_id, encPayload, clockTick, now);
      }

    } catch (err) {
      const errMsg = err.message ?? String(err);
      // The actor finished while the timer was due: nothing to deliver, ever.
      if (err.status === 409 && /terminated|archived/.test(err.body ?? '')) {
        await cancelScheduledEventById(row.id, errMsg);
        continue;
      }
      // The API server could not be reached or had a transient failure: the timer is not
      // at fault, so it neither spends a retry nor waits 30 s+ — it is late by seconds.
      if (err.status === undefined || err.status >= 500) {
        await retryScheduledEventSoon(row.id, Date.now() + UNREACHABLE_RETRY_MS, errMsg);
        console.warn(`[scheduler-worker] Scheduled event ${row.id}: server unreachable, retrying soon (${errMsg})`);
        continue;
      }
      await markDispatchFailed(row.id, errMsg);
      // Re-fetch row to get current retry_count before retry decision
      const refreshed = { ...row, status: 'failed' };
      await scheduleRetryOrFail(refreshed, errMsg);
      console.warn(`[scheduler-worker] Scheduled event ${row.id} failed: ${errMsg}`);
    }
  }
}

async function loop() {
  while (true) {
    try { await tick(); } catch (err) {
      console.error('[scheduler-worker] Unhandled error in tick:', err);
    }
    await new Promise(r => { setTimeout(r, POLL_INTERVAL); });
  }
}

loop();
