// src/registry/actionJobRepo.js
import { randomUUID } from 'crypto';
import { getDb, encrypt, decrypt, isPostgres } from './db.js';

export async function insertActionJob({ actorId, actionName, context, event, maxRetries, fireAt }) {
  const id  = randomUUID();
  const now = Date.now();
  const contextSnap = context != null ? encrypt(Buffer.from(JSON.stringify(context))) : null;
  const eventSnap   = event   != null ? JSON.stringify(event) : null;

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

export async function claimActionJobs(batchSize = 50) {
  if (isPostgres) {
    const { queryAll, query } = await import('./db-postgres.js');
    const rows = await queryAll(
      `SELECT * FROM action_jobs WHERE status='pending' AND next_retry_at <= $1 LIMIT $2`,
      [Date.now(), batchSize]
    );
    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      await query(`UPDATE action_jobs SET status='running' WHERE id=ANY($1::text[])`, [ids]);
    }
    return rows;
  }
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM action_jobs WHERE status='pending' AND next_retry_at <= ? LIMIT ?`
  ).all(Date.now(), batchSize);
  if (rows.length > 0) {
    const update = db.prepare(`UPDATE action_jobs SET status='running' WHERE id=?`);
    db.transaction(() => rows.forEach(r => update.run(r.id)))();
  }
  return rows;
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
