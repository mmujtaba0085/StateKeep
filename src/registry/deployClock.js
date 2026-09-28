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
    client.on('error', () => { broken = true; });
    try {
      await client.query('SELECT pg_advisory_lock($1::bigint)', [lockKey(family)]);
      try { return await fn(); }
      finally { await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey(family)]).catch(() => { broken = true; }); }
    } finally {
      client.release(broken);
    }
  });
}
