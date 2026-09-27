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
    await query(`UPDATE action_jobs SET status='failed', outcome='failed' WHERE id=$1`, [id]);
    return;
  }
  getDb().prepare(`UPDATE action_jobs SET status='failed', outcome='failed' WHERE id=?`).run(id);
}

// ── Delivery tracking (docs/side-effects.md) ────────────────────────────────
async function run(pgSql, sqliteSql, params) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    return query(pgSql, params);
  }
  return getDb().prepare(sqliteSql).run(...params);
}

/** Durably record that an attempt is about to be SENT. Must complete before the call. */
export const markActionJobStarted = (id) =>
  run(`UPDATE action_jobs SET started_at=$1 WHERE id=$2`, `UPDATE action_jobs SET started_at=? WHERE id=?`, [Date.now(), id]);

/** The implementation answered: keep its answer until the follow-up event is delivered. */
export const markActionJobSucceeded = (id, resultSnap) =>
  run(`UPDATE action_jobs SET outcome='succeeded', result_snap=$1 WHERE id=$2`,
      `UPDATE action_jobs SET outcome='succeeded', result_snap=? WHERE id=?`, [resultSnap, id]);

/** Retry later. `sent=false` means the attempt certainly never reached the implementation. */
export const retryActionJobAfter = (id, retryCount, nextRetryAt, { sent }) => sent
  ? run(`UPDATE action_jobs SET status='pending', retry_count=$1, next_retry_at=$2 WHERE id=$3`,
        `UPDATE action_jobs SET status='pending', retry_count=?, next_retry_at=? WHERE id=?`, [retryCount, nextRetryAt, id])
  : run(`UPDATE action_jobs SET status='pending', retry_count=$1, next_retry_at=$2, started_at=NULL WHERE id=$3`,
        `UPDATE action_jobs SET status='pending', retry_count=?, next_retry_at=?, started_at=NULL WHERE id=?`, [retryCount, nextRetryAt, id]);

/** Nobody can tell whether the side effect happened: stop and wait for a human. */
export const markActionJobUnknown = (id) =>
  run(`UPDATE action_jobs SET status='failed', outcome='unknown' WHERE id=$1`,
      `UPDATE action_jobs SET status='failed', outcome='unknown' WHERE id=?`, [id]);

/** Extend the lease of jobs still being worked on (long actions must not be claimed twice). */
export async function renewActionJobLeases(ids, until) {
  if (ids.length === 0) return;
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`UPDATE action_jobs SET next_retry_at=$1 WHERE status='running' AND id = ANY($2)`, [until, ids]);
    return;
  }
  const stmt = getDb().prepare(`UPDATE action_jobs SET next_retry_at=? WHERE status='running' AND id=?`);
  getDb().transaction(() => ids.forEach((id) => stmt.run(until, id)))();
}

const toJob = (r) => r && ({
  id: r.id, actorId: r.actor_id, actionName: r.action_name, status: r.status, outcome: r.outcome ?? null,
  retryCount: r.retry_count, startedAt: r.started_at == null ? null : Number(r.started_at), createdAt: Number(r.created_at),
});

export async function listActionJobs({ outcome = 'unknown', limit = 100 } = {}) {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    return (await queryAll(`SELECT * FROM action_jobs WHERE outcome=$1 ORDER BY created_at LIMIT $2`, [outcome, limit])).map(toJob);
  }
  return getDb().prepare(`SELECT * FROM action_jobs WHERE outcome=? ORDER BY created_at LIMIT ?`).all(outcome, limit).map(toJob);
}

export async function getActionJob(id) {
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    return toJob(await queryOne(`SELECT * FROM action_jobs WHERE id=$1`, [id]));
  }
  return toJob(getDb().prepare(`SELECT * FROM action_jobs WHERE id=?`).get(id));
}

/**
 * A human decided an 'unknown' job: it happened (→ done) or it did not (→ run it again).
 * Only jobs still marked unknown change (so two reviewers can't both act).
 */
export async function resolveActionJob(id, happened) {
  const res = happened
    ? await run(`UPDATE action_jobs SET status='done', outcome='resolved-happened' WHERE id=$1 AND outcome='unknown'`,
                `UPDATE action_jobs SET status='done', outcome='resolved-happened' WHERE id=? AND outcome='unknown'`, [id])
    // 'rerun-approved' travels with the next attempt, so an implementation that still has
    // the job marked as started (e.g. it crashed mid-call) knows a human cleared it.
    // A fresh retry budget: earlier failures belong to the attempt that was reviewed.
    : await run(`UPDATE action_jobs SET status='pending', outcome='rerun-approved', started_at=NULL, retry_count=0, next_retry_at=$1 WHERE id=$2 AND outcome='unknown'`,
                `UPDATE action_jobs SET status='pending', outcome='rerun-approved', started_at=NULL, retry_count=0, next_retry_at=? WHERE id=? AND outcome='unknown'`, [Date.now(), id]);
  return (res.rowCount ?? res.changes ?? 0) > 0;
}
