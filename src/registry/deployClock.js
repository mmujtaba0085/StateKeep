/**
 * t* for a new deployment.
 *
 * SQLite (one writer): the in-process APV engine clock, as before.
 * Postgres (possibly several API servers): a database sequence, so every server hands
 * out unique, increasing t*s; the local engine clock is advanced past it so the
 * engine never sees a t* from its own future.
 */
import { isPostgres } from './db.js';

export async function nextDeployTick(eng) {
  if (!isPostgres) return eng.clockTick();
  const { queryOne } = await import('./db-postgres.js');
  let t = BigInt((await queryOne(`SELECT nextval('statekeep_deploy_clock') AS t`)).t);
  if (eng.available) {
    // t* must also be later than every tick this server has handed out, or actors it
    // spawned "before" this deployment would look newer than it.
    let cur = BigInt(eng.clockTick());
    if (cur > t) {
      t = BigInt((await queryOne(`SELECT GREATEST(nextval('statekeep_deploy_clock'), $1::bigint) AS t`, [String(cur)])).t);
      await queryOne(`SELECT setval('statekeep_deploy_clock', GREATEST($1::bigint, (SELECT last_value FROM statekeep_deploy_clock)))`, [String(t)]);
    }
    eng.advanceClockTo(t);
  }
  return t;
}

/**
 * Deployments of one workflow family are serialized: its deployment times are drawn and
 * committed in the same order, so a deployment is always later than every deployment of
 * the family that committed before it (the clock invariant of the APV model, docs/apv.md).
 * Postgres: a session advisory lock keyed by the family, held on a dedicated connection
 * for the whole deployment (every API server honours it). SQLite: one writer process, so
 * an in-process queue per family is enough.
 */
const localQueues = new Map();
function localLock(key, fn) {
  const prev = localQueues.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  localQueues.set(key, tail);
  tail.then(() => { if (localQueues.get(key) === tail) localQueues.delete(key); });
  return run;
}

function lockKey(family) {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(`deploy:${family}`, 'utf8')) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return BigInt.asIntN(64, h).toString();
}

export async function withFamilyDeployLock(family, fn) {
  return localLock(family, async () => {
    if (!isPostgres) return fn();
    const { getPool } = await import('./db-postgres.js');
    const client = await getPool().connect();
    let broken = false;
    const onError = () => { broken = true; };
    client.on('error', onError);
    try {
      await client.query('SELECT pg_advisory_lock($1::bigint)', [lockKey(family)]);
      try { return await fn(); }
      finally { await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey(family)]).catch(() => { broken = true; }); }
    } finally {
      client.off('error', onError);           // pooled clients are reused: do not leak listeners
      client.release(broken);
    }
  });
}

/**
 * The newest committed deployment time of a family, read so that no deployment of the
 * family is in progress: a deployment holds the family lock until it is committed (after
 * its visibility barrier), and this read takes the same lock in shared mode (Postgres:
 * a transaction-scoped shared advisory lock; SQLite: the in-process family queue). A spawn
 * dated by it therefore never counts a deployment that has not committed yet, and never
 * misses one that has.
 */
export async function readFamilyMaxDeployed(family, readFn) {
  return localLock(family, async () => {
    if (!isPostgres) return readFn();
    const { transaction } = await import('./db-postgres.js');
    // Each holder keeps one pooled connection for the lock while readFn uses others:
    // bound how many do so at once, so concurrent spawns cannot exhaust the pool.
    return withSpawnSlot(() => transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [lockKey(family)]);
      return readFn();
    }));
  });
}

const SPAWN_SLOTS = Math.max(1, Math.floor(parseInt(process.env.STATEKEEP_PG_POOL_SIZE ?? '20', 10) / 4));
let _slotsInUse = 0;
const _slotWaiters = [];
async function withSpawnSlot(fn) {
  if (_slotsInUse >= SPAWN_SLOTS) await new Promise((r) => _slotWaiters.push(r));
  _slotsInUse++;
  try { return await fn(); }
  finally { _slotsInUse--; _slotWaiters.shift()?.(); }
}
