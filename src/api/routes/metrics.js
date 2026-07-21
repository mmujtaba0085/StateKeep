/**
 * src/api/routes/metrics.js
 * GET /v1/metrics — Prometheus text format. No auth required.
 */

import { getDb, isPostgres } from '../../registry/db.js';

export async function metricsRoutes(fastify) {
  fastify.get('/v1/metrics', async (_req, reply) => {
    let snap;
    if (isPostgres) {
      const { queryOne } = await import('../../registry/db-postgres.js');
      snap = await queryOne(`SELECT * FROM metrics_snapshots ORDER BY captured_at DESC LIMIT 1`, []);
    } else {
      snap = getDb().prepare(`SELECT * FROM metrics_snapshots ORDER BY captured_at DESC LIMIT 1`).get();
    }

    const lines = [];
    const ts = snap?.captured_at ?? Date.now();

    function g(name, help, type, value) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name} ${value ?? 0} ${ts}`);
    }

    g('statekeep_actors_active',         'Active actor count',               'gauge',   snap?.active_actors);
    g('statekeep_actors_migrating',       'Migrating actor count',            'gauge',   snap?.migrating_actors);
    g('statekeep_actors_archived',        'Archived actor count',             'gauge',   snap?.archived_actors);
    g('statekeep_definitions_total',      'Definition count',                 'gauge',   snap?.definitions_count);
    g('statekeep_migration_jobs_pending', 'Pending migration jobs',           'gauge',   snap?.pending_jobs);
    g('statekeep_ffi_calls_total',        'Total FFI calls',                  'counter', snap?.ffi_calls_total);
    g('statekeep_ffi_latency_p50_ms',     'FFI call latency p50 ms',          'gauge',   snap?.ffi_latency_p50_ms);
    g('statekeep_ffi_latency_p99_ms',     'FFI call latency p99 ms',          'gauge',   snap?.ffi_latency_p99_ms);
    g('statekeep_api_requests_total',     'Total API requests processed',     'counter', snap?.api_requests_total);
    g('statekeep_api_latency_p50_ms',     'API request latency p50 ms',       'gauge',   snap?.api_latency_p50_ms);
    g('statekeep_api_latency_p95_ms',     'API request latency p95 ms',       'gauge',   snap?.api_latency_p95_ms);
    g('statekeep_api_latency_p99_ms',     'API request latency p99 ms',       'gauge',   snap?.api_latency_p99_ms);
    g('statekeep_wal_size_bytes',         'SQLite WAL file size bytes',       'gauge',   snap?.wal_size_bytes);
    g('statekeep_process_uptime_seconds', 'API process uptime',               'gauge',   Math.floor(process.uptime()));

    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return reply.send(lines.join('\n') + '\n');
  });
}
