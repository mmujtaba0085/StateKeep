// src/registry/actionJobRepo.js
import { randomUUID } from 'crypto';
import { getDb, encrypt, isPostgres } from './db.js';

export async function insertActionJob({ actorId, actionName, context, event, maxRetries, fireAt }) {
  const id  = randomUUID();
  const now = Date.now();
  const contextSnap = context != null ? encrypt(Buffer.from(JSON.stringify(context))) : null;
  const eventSnap   = event   != null ? encrypt(Buffer.from(JSON.stringify(event))) : null;

  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(
      `INSERT INTO action_jobs (id, actor_id, action_name, context_snap, event_snap, max_retries, next_retry_at, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
      [id, actorId, actionName, contextSnap, eventSnap, maxRetries, fireAt ?? now, now]
    );
    return id;
  }
  getDb().prepare(
    `INSERT INTO action_jobs (id, actor_id, action_name, context_snap, event_snap, max_retries, next_retry_at, status, created_at)
     VALUES (?,?,?,?,?,?,?,'pending',?)`
  ).run(id, actorId, actionName, contextSnap, eventSnap, maxRetries, fireAt ?? now, now);
  return id;
}

// A claimed job is leased: status 'running' with next_retry_at = lease expiry. If the
// server holding it dies (kill -9, OOM, deploy), the lease runs out and another poll
// claims it again — before this, such a job stayed 'running' forever and its action
// never ran. Actions are therefore at-least-once (remote calls carry the job id).
export const ACTION_JOB_LEASE_MS = parseInt(process.env.STATEKEEP_ACTION_LEASE_MS ?? '120000', 10);

export async function claimActionJobs(batchSize = 50) {
  const now = Date.now();
  const leaseUntil = now + ACTION_JOB_LEASE_MS;
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    return queryAll(
      `WITH claimed AS (
         SELECT id FROM action_jobs
         WHERE status IN ('pending','running') AND next_retry_at <= $1
         ORDER BY next_retry_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE action_jobs SET status='running', next_retry_at=$3
       WHERE id IN (SELECT id FROM claimed)
       RETURNING *`,
      [now, batchSize, leaseUntil]
    );
  }
  const db = getDb();
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT * FROM action_jobs WHERE status IN ('pending','running') AND next_retry_at <= ? ORDER BY next_retry_at LIMIT ?`
    ).all(now, batchSize);
    const update = db.prepare(`UPDATE action_jobs SET status='running', next_retry_at=? WHERE id=?`);
    rows.forEach((r) => update.run(leaseUntil, r.id));
    return rows;
  })();
}

export async function markActionJobDone(id) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`UPDATE action_jobs SET status='done' WHERE id=$1`, [id]);
    return;
  }
  getDb().prepare(`UPDATE action_jobs SET status='done' WHERE id=?`).run(id);
}

export async function retryActionJob(id, retryCount, nextRetryAt) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(
      `UPDATE action_jobs SET status='pending', retry_count=$1, next_retry_at=$2 WHERE id=$3`,
      [retryCount, nextRetryAt, id]
    );
    return;
  }
  getDb().prepare(
    `UPDATE action_jobs SET status='pending', retry_count=?, next_retry_at=? WHERE id=?`
  ).run(retryCount, nextRetryAt, id);
}

export async function markActionJobFailed(id) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`UPDATE action_jobs SET status='failed' WHERE id=$1`, [id]);
    return;
  }
  getDb().prepare(`UPDATE action_jobs SET status='failed' WHERE id=?`).run(id);
}
