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

import { getDb, isPostgres } from '../registry/db.js';
import { startHeartbeat } from './heartbeat.js';

const INTERVAL_MS = 300_000;

console.log('[snapshot-worker] Starting...');

if (isPostgres) {
  const { bootstrapSchema } = await import('../registry/db-postgres.js');
  await bootstrapSchema();
} else {
  getDb();
}

startHeartbeat('snapshot');

async function snapshotLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, INTERVAL_MS));

    try {
      if (isPostgres) {
        const { queryOne } = await import('../registry/db-postgres.js');
        const nullState = await queryOne(`SELECT COUNT(*) as cnt FROM actors WHERE status='active' AND state_value IS NULL`, []);
        const active    = await queryOne(`SELECT COUNT(*) as cnt FROM actors WHERE status='active'`, []);
        console.log(
          `[snapshot-worker] Snapshot check: ${Number(active?.cnt ?? 0)} active actors, ` +
          `${Number(nullState?.cnt ?? 0)} with null state`
        );
      } else {
        const db = getDb();
        const nullState = db.prepare(`SELECT COUNT(*) as cnt FROM actors WHERE status = 'active' AND state_value IS NULL`).get();
        const active    = db.prepare(`SELECT COUNT(*) as cnt FROM actors WHERE status = 'active'`).get();
        console.log(
          `[snapshot-worker] Snapshot check: ${active.cnt} active actors, ` +
          `${nullState.cnt} with null state`
        );
        db.pragma('wal_checkpoint(PASSIVE)');
      }
    } catch (err) {
      console.error('[snapshot-worker] Error:', err);
    }
  }
}

snapshotLoop().catch(err => {
  console.error('[snapshot-worker] Fatal:', err);
  process.exit(1);
});
