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

import { getDb, encrypt } from '../registry/db.js';
import { findDueEvents, markFired, markFailed, markDispatchFailed, scheduleRetryOrFail } from '../registry/scheduledEventRepo.js';
import { startHeartbeat } from './heartbeat.js';
import { findActorById } from '../registry/actorRepo.js';
import { sendEvent } from '../runtime/actorManager.js';
import { getEngine, engineReady } from '../ffi/engine.js';

const POLL_INTERVAL = parseInt(process.env.SCHEDULER_POLL_INTERVAL ?? '5000', 10);
const SKIP_STATUSES = new Set(['terminated', 'archived', 'needs_rescue']);

console.log('[scheduler-worker] Starting...');

await engineReady;
getDb();   // bootstrap DB + run migrations
startHeartbeat('scheduler');

async function tick() {
  const now  = Date.now();
  const rows = findDueEvents(now);

  for (const row of rows) {
    // Check actor before claiming — retry or permanently fail if actor is gone/terminal
    const actor = findActorById(row.actor_id);
    if (!actor || SKIP_STATUSES.has(actor.status)) {
      const reason = `actor ${actor ? actor.status : 'not found'}`;
      scheduleRetryOrFail(row, reason);
      continue;
    }

    // Claim atomically — markFired returns 0 if another worker beat us
    const claimed = markFired(row.id, now);
    if (!claimed) continue;

    try {

      const eng        = getEngine();
      const clockTick  = eng.available ? Number(eng.clockTick()) : Date.now();
      const event      = { type: row.event_type, ...(row.payload ?? {}) };

      await sendEvent(row.actor_id, event, clockTick);

      // Write SCHEDULED_EVENT_FIRED to event log
      const db = getDb();
      const encPayload = row.payload
        ? encrypt(Buffer.from(JSON.stringify(row.payload)))
        : null;
      db.prepare(`
        INSERT INTO events (actor_id, org_id, event_type, event_payload, tick, processed_at)
        VALUES (?, ?, 'SCHEDULED_EVENT_FIRED', ?, ?, ?)
      `).run(row.actor_id, row.org_id, encPayload, clockTick, now);

    } catch (err) {
      const errMsg = err.message ?? String(err);
      // markFired already transitioned to 'fired'; fall back to markDispatchFailed
      // then schedule a retry from the current row (still has original retry_count)
      markDispatchFailed(row.id, errMsg);
      // Re-fetch row to get current retry_count before retry decision
      const refreshed = { ...row, status: 'failed' };
      scheduleRetryOrFail(refreshed, errMsg);
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
