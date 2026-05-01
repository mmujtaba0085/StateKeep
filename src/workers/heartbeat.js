/**
 * src/workers/heartbeat.js
 *
 * Writes a periodic heartbeat row for the calling worker process.
 * The interval is unref()'d so it does not prevent process exit.
 * Any DB error is silently swallowed — heartbeat failures must never
 * crash a worker.
 */

import { getDb } from '../registry/db.js';

export function startHeartbeat(workerType, intervalMs = 30_000) {
  const workerId  = `${workerType}-${process.pid}`;
  const startedAt = Date.now();
  const db        = getDb();

  // Prune stale rows for this worker type before registering ourselves.
  // A row is stale if last_beat is older than 2 minutes — it belongs to a
  // crashed process that never cleaned up.
  try {
    db.prepare(`
      DELETE FROM worker_heartbeats
      WHERE worker_type = ? AND last_beat < ?
    `).run(workerType, Date.now() - 120_000);
  } catch {}

  const upsert = db.prepare(`
    INSERT INTO worker_heartbeats (worker_id, worker_type, last_beat, started_at, pid)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(worker_id) DO UPDATE SET last_beat = excluded.last_beat
  `);

  // Cached DELETE — prepared once, reused in both SIGTERM and SIGINT handlers.
  const del = db.prepare(`DELETE FROM worker_heartbeats WHERE worker_id = ?`);

  // Write immediately on startup
  try { upsert.run(workerId, workerType, Date.now(), startedAt, process.pid); } catch {}

  const interval = setInterval(() => {
    try { upsert.run(workerId, workerType, Date.now(), startedAt, process.pid); } catch {}
  }, intervalMs);

  interval.unref();

  process.on('SIGTERM', () => { try { del.run(workerId); } catch {} });
  process.on('SIGINT',  () => { try { del.run(workerId); } catch {} });

  return { workerId, stop: () => clearInterval(interval) };
}
