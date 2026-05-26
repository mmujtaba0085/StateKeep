/**
 * src/workers/metrics-worker.js
 *
 * Background process: aggregates metrics every 60s and writes to
 * metrics_snapshots table. The Fastify /v1/metrics route reads this table.
 *
 * Managed by statekeep-metrics-worker.service (systemd).
 */

import { statSync } from 'fs';
import { getDb } from '../registry/db.js';
import { startHeartbeat } from './heartbeat.js';

const INTERVAL_MS   = 60_000;
const DB_PATH       = process.env.STATEKEEP_DB_PATH ?? 'data/statekeep.db';
const WAL_PATH      = DB_PATH + '-wal';

// Latency tracking (exported from actors route via shared in-process state)
// When running as a separate process, we read from the metrics_snapshots table
// and rely on the API process to export counters to SQLite.
// This worker aggregates DB-computable metrics only; latency histograms are
// written by the API process directly via hook.

console.log('[metrics-worker] Starting...');
const db = getDb();
startHeartbeat('metrics');

let totalRequests = 0;

async function collectMetrics() {
  const actorCounts = {};
  for (const row of db.prepare(`SELECT status, COUNT(*) as cnt FROM actors GROUP BY status`).all()) {
    actorCounts[row.status] = row.cnt;
  }

  const definitionsCount = db.prepare(`SELECT COUNT(*) as cnt FROM definitions WHERE status='active'`).get()?.cnt ?? 0;
  const pendingJobs      = db.prepare(`SELECT COUNT(*) as cnt FROM migration_jobs WHERE status='pending'`).get()?.cnt ?? 0;

  // WAL file size
  let walSize = 0;
  try { walSize = statSync(WAL_PATH).size; } catch {}

  // Read latest api_latency from previous snapshot for continuity
  const prev = db.prepare(`SELECT * FROM metrics_snapshots ORDER BY captured_at DESC LIMIT 1`).get();

  db.prepare(`
    INSERT INTO metrics_snapshots
      (captured_at, active_actors, migrating_actors, archived_actors,
       definitions_count, pending_jobs, ffi_calls_total,
       ffi_latency_p50_ms, ffi_latency_p99_ms,
       api_requests_total, api_latency_p50_ms, api_latency_p95_ms, api_latency_p99_ms,
       wal_size_bytes)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Date.now(),
    actorCounts['active']    ?? 0,
    actorCounts['migrating'] ?? 0,
    actorCounts['archived']  ?? 0,
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

  // Prune old snapshots (keep 7 days)
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  db.prepare(`DELETE FROM metrics_snapshots WHERE captured_at < ?`).run(cutoff);
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
