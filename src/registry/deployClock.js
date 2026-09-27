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
    while (cur < t) cur = BigInt(eng.clockTick());
  }
  return t;
}
