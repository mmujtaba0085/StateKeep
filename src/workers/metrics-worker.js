/**
 * src/workers/metrics-worker.js
 *
 * Background process: aggregates metrics every 60s and writes to
 * metrics_snapshots table. The Fastify /v1/metrics route reads this table.
 *
 * Managed by statekeep-metrics-worker.service (systemd).
 */

import { statSync } from 'fs';
import { getDb, isPostgres } from '../registry/db.js';
import { startHeartbeat } from './heartbeat.js';

const INTERVAL_MS = 60_000;
const DB_PATH     = process.env.STATEKEEP_DB_PATH ?? 'data/statekeep.db';
const WAL_PATH    = DB_PATH + '-wal';

console.log('[metrics-worker] Starting...');

if (isPostgres) {
  const { bootstrapSchema } = await import('../registry/db-postgres.js');
  await bootstrapSchema();
} else {
  getDb();
}

startHeartbeat('metrics');

async function collectMetrics() {
  if (isPostgres) {
    const { queryAll, queryOne, query } = await import('../registry/db-postgres.js');

    const actorRows      = await queryAll(`SELECT status, COUNT(*) as cnt FROM actors GROUP BY status`, []);
    const actorCounts    = {};
    for (const r of actorRows) actorCounts[r.status] = Number(r.cnt);

    const defRow         = await queryOne(`SELECT COUNT(*) as cnt FROM definitions WHERE status='active'`, []);
    const definitionsCount = Number(defRow?.cnt ?? 0);

    const jobRow         = await queryOne(`SELECT COUNT(*) as cnt FROM migration_jobs WHERE status='pending'`, []);
    const pendingJobs    = Number(jobRow?.cnt ?? 0);

    const prev           = await queryOne(`SELECT * FROM metrics_snapshots ORDER BY captured_at DESC LIMIT 1`, []);
    const now            = Date.now();

    await query(
      `INSERT INTO metrics_snapshots
        (captured_at, active_actors, migrating_actors, archived_actors,
         definitions_count, pending_jobs, ffi_calls_total,
         ffi_latency_p50_ms, ffi_latency_p99_ms,
         api_requests_total, api_latency_p50_ms, api_latency_p95_ms, api_latency_p99_ms,
         wal_size_bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        now,
        actorCounts['active']    ?? 0,
        actorCounts['migrating'] ?? 0,
        actorCounts['archived']  ?? 0,
        definitionsCount,
        pendingJobs,
        prev?.ffi_calls_total    ?? 0,
        prev?.ffi_latency_p50_ms ?? 0,
        prev?.ffi_latency_p99_ms ?? 0,
        prev?.api_requests_total ?? 0,
        prev?.api_latency_p50_ms ?? 0,
        prev?.api_latency_p95_ms ?? 0,
        prev?.api_latency_p99_ms ?? 0,
        0,   // WAL size not applicable in Postgres
      ]
    );

    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    await query(`DELETE FROM metrics_snapshots WHERE captured_at<$1`, [cutoff]);
  } else {
    const db = getDb();
    const actorCounts = {};
    for (const row of db.prepare(`SELECT status, COUNT(*) as cnt FROM actors GROUP BY status`).all()) {
      actorCounts[row.status] = row.cnt;
    }

    const definitionsCount = db.prepare(`SELECT COUNT(*) as cnt FROM definitions WHERE status='active'`).get()?.cnt ?? 0;
    const pendingJobs      = db.prepare(`SELECT COUNT(*) as cnt FROM migration_jobs WHERE status='pending'`).get()?.cnt ?? 0;

    let walSize = 0;
    try { walSize = statSync(WAL_PATH).size; } catch {}

    const prev = db.prepare(`SELECT * FROM metrics_snapshots ORDER BY captured_at DESC LIMIT 1`).get();

    db.prepare(`
      INSERT INTO metrics_snapshots
        (captured_at, active_actors, migrating_actors, archived_actors,
         definitions_count, pending_jobs, ffi_calls_total,
         ffi_latency_p50_ms, ffi_latency_p99_ms,
         api_requests_total, api_latency_p50_ms, api_latency_p95_ms, api_latency_p99_ms,
         wal_size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      actorCounts['active']        ?? 0,
      actorCounts['migrating']     ?? 0,
      actorCounts['archived']      ?? 0,
      definitionsCount,
      pendingJobs,
      prev?.ffi_calls_total        ?? 0,
      prev?.ffi_latency_p50_ms     ?? 0,
      prev?.ffi_latency_p99_ms     ?? 0,
      prev?.api_requests_total     ?? 0,
      prev?.api_latency_p50_ms     ?? 0,
      prev?.api_latency_p95_ms     ?? 0,
      prev?.api_latency_p99_ms     ?? 0,
      walSize,
    );

    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    db.prepare(`DELETE FROM metrics_snapshots WHERE captured_at < ?`).run(cutoff);
  }
}

async function metricsLoop() {
  while (true) {
    try {
      await collectMetrics();
    } catch (err) {
      console.error('[metrics-worker] Error:', err);
    }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
}

metricsLoop().catch(err => {
  console.error('[metrics-worker] Fatal:', err);
  process.exit(1);
});
