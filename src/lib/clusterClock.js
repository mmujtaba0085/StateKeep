/**
 * src/lib/clusterClock.js — one clock for due times shared between servers.
 *
 * Timer due times (after:, scheduled events), action-job leases and retry times are
 * written by one server and compared by another, so they must not depend on each
 * server's own wall clock. On Postgres, now() is this server's clock corrected by its
 * measured offset to the database clock (re-measured every few seconds, with the round
 * trip halved), so a server whose clock is minutes off fires timers and judges leases
 * on the same time line as the others. On SQLite (one process) it is Date.now().
 *
 * Correctness of routing and ownership does not use any clock (registry epoch,
 * ownership generations); this only keeps time-based work on time.
 */
import { isPostgres } from '../registry/db.js';

const RESYNC_MS = parseInt(process.env.STATEKEEP_CLOCK_RESYNC_MS ?? '5000', 10);
let offset = 0;
let timer = null;

// Test-only switch (NODE_ENV=test): lets test/cluster/skew.test.js show it detects its absence.
const DISABLED = process.env.NODE_ENV === 'test' && process.env.STATEKEEP_TEST_DISABLE_CLUSTER_CLOCK === '1';

export function now() {
  if (DISABLED) return Date.now();
  if (isPostgres && !timer) startClusterClock();
  return Date.now() + offset;
}

export async function syncClusterClock() {
  if (!isPostgres) return;
  const { queryOne } = await import('../registry/db-postgres.js');
  const t0 = Date.now();
  const row = await queryOne(`SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS t`);
  const t1 = Date.now();
  offset = Number(row.t) - Math.round((t0 + t1) / 2);
}

/** Measure now and keep re-measuring. Awaitable at startup; safe to call again. */
export function startClusterClock() {
  if (!isPostgres) return Promise.resolve();
  if (!timer) {
    timer = setInterval(() => { syncClusterClock().catch(() => {}); }, RESYNC_MS);
    timer.unref?.();
  }
  return syncClusterClock().catch(() => {});
}

export const clockOffsetMs = () => offset;
