/**
 * src/workers/heartbeat.js
 *
 * Writes a periodic heartbeat row for the calling worker process.
 * The interval is unref()'d so it does not prevent process exit.
 * Any DB error is silently swallowed — heartbeat failures must never
 * crash a worker.
 */

import { getDb, isPostgres } from '../registry/db.js';

export function startHeartbeat(workerType, intervalMs = 30_000) {
  const workerId  = `${workerType}-${process.pid}`;
  const startedAt = Date.now();

  async function upsertBeat() {
    if (isPostgres) {
      const { query } = await import('../registry/db-postgres.js');
      await query(
        `INSERT INTO worker_heartbeats (worker_id, worker_type, last_beat, started_at, pid)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT(worker_id) DO UPDATE SET last_beat=EXCLUDED.last_beat`,
        [workerId, workerType, Date.now(), startedAt, process.pid]
      );
    } else {
      const db = getDb();
      db.prepare(`
        INSERT INTO worker_heartbeats (worker_id, worker_type, last_beat, started_at, pid)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(worker_id) DO UPDATE SET last_beat = excluded.last_beat
      `).run(workerId, workerType, Date.now(), startedAt, process.pid);
    }
  }

  async function pruneOtherInstances() {
    if (isPostgres) {
      const { query } = await import('../registry/db-postgres.js');
      await query(
        `DELETE FROM worker_heartbeats WHERE worker_type=$1 AND worker_id!=$2`,
        [workerType, workerId]
      );
    } else {
      try {
        getDb().prepare(`
          DELETE FROM worker_heartbeats WHERE worker_type = ? AND worker_id != ?
        `).run(workerType, workerId);
      } catch {}
    }
  }

  async function deleteBeat() {
    if (isPostgres) {
      const { query } = await import('../registry/db-postgres.js');
      await query(`DELETE FROM worker_heartbeats WHERE worker_id=$1`, [workerId]);
    } else {
      try { getDb().prepare(`DELETE FROM worker_heartbeats WHERE worker_id = ?`).run(workerId); } catch {}
    }
  }

  // Remove stale records from prior runs of this worker type
  pruneOtherInstances().catch(() => {});

  // Write immediately on startup
  upsertBeat().catch(() => {});

  const interval = setInterval(() => {
    upsertBeat().catch(() => {});
  }, intervalMs);

  interval.unref();

  process.on('SIGTERM', () => { deleteBeat().catch(() => {}); });
  process.on('SIGINT',  () => { deleteBeat().catch(() => {}); });

  return { workerId, stop: () => clearInterval(interval) };
}
