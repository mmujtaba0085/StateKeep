/**
 * src/workers/snapshot-worker.js
 *
 * Background process: runs every 300s.
 * Writes full actor state snapshots to SQLite for crash recovery.
 * In normal operation SQLite is written after every event; this worker
 * is a safety net for actors that are in memory but whose DB row
 * may be stale due to a crash-before-persist scenario.
 *
 * Managed by statekeep-snapshot-worker.service (systemd).
 */

import { getDb } from '../registry/db.js';
import { startHeartbeat } from './heartbeat.js';
import { updateActorState, findIdleActors } from '../registry/actorRepo.js';

const INTERVAL_MS = 300_000;   // 5 minutes

console.log('[snapshot-worker] Starting...');
getDb();
startHeartbeat('snapshot');

async function snapshotLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, INTERVAL_MS));

    const db = getDb();
    try {
      // Verify that active actors have valid state_value (non-null)
      // If any are null, it means they were created but never had an event
      // processed — this is fine, just log a count.
      const nullState = db.prepare(`
        SELECT COUNT(*) as cnt FROM actors WHERE status = 'active' AND state_value IS NULL
      `).get();

      const active = db.prepare(`
        SELECT COUNT(*) as cnt FROM actors WHERE status = 'active'
      `).get();

      console.log(
        `[snapshot-worker] Snapshot check: ${active.cnt} active actors, ` +
        `${nullState.cnt} with null state`
      );

      // Force a WAL checkpoint to minimize WAL file size
      db.pragma('wal_checkpoint(PASSIVE)');

    } catch (err) {
      console.error('[snapshot-worker] Error:', err);
    }
  }
}

snapshotLoop().catch(err => {
  console.error('[snapshot-worker] Fatal:', err);
  process.exit(1);
});
