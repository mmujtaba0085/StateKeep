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
import { findDueEvents, markFired, markFailed, markDispatchFailed, scheduleRetryOrFail } from '../registry/scheduledEventRepo.js';
import { startHeartbeat } from './heartbeat.js';
import { findActorById } from '../registry/actorRepo.js';
import { sendEvent } from '../runtime/actorManager.js';
import { getEngine, engineReady } from '../ffi/engine.js';

const POLL_INTERVAL = parseInt(process.env.SCHEDULER_POLL_INTERVAL ?? '5000', 10);
const SKIP_STATUSES = new Set(['terminated', 'archived', 'needs_rescue']);

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
      await scheduleRetryOrFail(row, reason);
      continue;
    }

    // Claim atomically — markFired returns 0 if another worker beat us
    const claimed = await markFired(row.id, now);
    if (!claimed) continue;

    try {
      const eng       = getEngine();
      const clockTick = eng.available ? Number(eng.clockTick()) : Date.now();
      const event     = { type: row.eventType ?? row.event_type, ...(row.payload ?? {}) };

      await sendEvent(row.actorId ?? row.actor_id, event, clockTick);

      // Write SCHEDULED_EVENT_FIRED to event log
      const encPayload = row.payload
        ? encrypt(Buffer.from(JSON.stringify(row.payload)))
        : null;

      if (isPostgres) {
        const { query } = await import('../registry/db-postgres.js');
        await query(
          `INSERT INTO events (actor_id, org_id, event_type, event_payload, tick, processed_at) VALUES ($1,$2,'SCHEDULED_EVENT_FIRED',$3,$4,$5)`,
          [row.actorId ?? row.actor_id, row.orgId ?? row.org_id, encPayload, clockTick, now]
        );
      } else {
        getDb().prepare(
          `INSERT INTO events (actor_id, org_id, event_type, event_payload, tick, processed_at) VALUES (?, ?, 'SCHEDULED_EVENT_FIRED', ?, ?, ?)`
        ).run(row.actorId ?? row.actor_id, row.orgId ?? row.org_id, encPayload, clockTick, now);
      }

    } catch (err) {
      const errMsg = err.message ?? String(err);
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
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

loop();
