/**
 * src/registry/jobRepo.js
 * SQLite/Postgres CRUD for the `migration_jobs` job queue.
 */

import { getDb, isPostgres } from './db.js';

let stmts = null;

function getStmts() {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    insert: db.prepare(`
      INSERT INTO migration_jobs
        (deployment_id, actor_id, org_id, target_def_id, status, created_at, updated_at)
      VALUES
        (@deployment_id, @actor_id, @org_id, @target_def_id, 'pending', @ts, @ts)
    `),
    claimBatch: db.prepare(`
      UPDATE migration_jobs
      SET status = 'processing', updated_at = ?
      WHERE id IN (
        SELECT id FROM migration_jobs
        WHERE status = 'pending'
        LIMIT ?
      )
      RETURNING *
    `),
    markDone: db.prepare(`
      UPDATE migration_jobs SET status = 'done', updated_at = ? WHERE id = ?
    `),
    markFailed: db.prepare(`
      UPDATE migration_jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?
    `),
    pendingCount:  db.prepare(`SELECT COUNT(*) as cnt FROM migration_jobs WHERE status = 'pending'`),
    countByStatus: db.prepare(`SELECT status, COUNT(*) as cnt FROM migration_jobs GROUP BY status`),
    resetProcessing: db.prepare(`
      UPDATE migration_jobs SET status = 'pending', updated_at = ? WHERE status = 'processing'
    `),
  };
  return stmts;
}

export async function enqueueJobs(jobs) {
  const ts = Date.now();
  if (isPostgres) {
    const { transaction } = await import('./db-postgres.js');
    await transaction(async (client) => {
      for (const j of jobs) {
        await client.query(
          `INSERT INTO migration_jobs
             (deployment_id, actor_id, org_id, target_def_id, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'pending',$5,$5)`,
          [j.deployment_id, j.actor_id, j.org_id, j.target_def_id, ts]
        );
      }
    });
    return;
  }
  const db  = getDb();
  const s   = getStmts();
  const txn = db.transaction((jobs) => { for (const j of jobs) s.insert.run({ ...j, ts }); });
  txn(jobs);
}

export async function claimBatch(limit = 100) {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    // FOR UPDATE SKIP LOCKED prevents double-claiming under concurrent workers
    return queryAll(
      `WITH pending AS (
         SELECT id FROM migration_jobs WHERE status='pending' LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE migration_jobs SET status='processing', updated_at=$2
       WHERE id IN (SELECT id FROM pending)
       RETURNING *`,
      [limit, Date.now()]
    );
  }
  return getStmts().claimBatch.all(Date.now(), limit);
}

export async function markDone(jobId) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`UPDATE migration_jobs SET status='done', updated_at=$1 WHERE id=$2`, [Date.now(), jobId]);
    return;
  }
  getStmts().markDone.run(Date.now(), jobId);
}

export async function markFailed(jobId, errorMessage) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`UPDATE migration_jobs SET status='failed', error_message=$1, updated_at=$2 WHERE id=$3`, [errorMessage, Date.now(), jobId]);
    return;
  }
  getStmts().markFailed.run(errorMessage, Date.now(), jobId);
}

export async function pendingCount() {
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    const row = await queryOne(`SELECT COUNT(*) as cnt FROM migration_jobs WHERE status='pending'`);
    return Number(row?.cnt ?? 0);
  }
  return getStmts().pendingCount.get().cnt;
}

export async function countByStatus() {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    const rows = await queryAll(`SELECT status, COUNT(*) as cnt FROM migration_jobs GROUP BY status`);
    const result = {};
    for (const r of rows) result[r.status] = Number(r.cnt);
    return result;
  }
  const rows = getStmts().countByStatus.all();
  const result = {};
  for (const r of rows) result[r.status] = r.cnt;
  return result;
}

export async function resetProcessingJobs() {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`UPDATE migration_jobs SET status='pending', updated_at=$1 WHERE status='processing'`, [Date.now()]);
    return;
  }
  getStmts().resetProcessing?.run(Date.now());
}

export async function logDecision({
  actorId, orgId, deploymentId = null, trigger, evaluatedAt,
  decision, reason, fromDefinitionId = null, toDefinitionId = null,
  actorFingerprint, prefixHash = '0',
}) {
  try {
    if (isPostgres) {
      const { query } = await import('./db-postgres.js');
      await query(
        `INSERT INTO migration_decisions
           (actor_id, org_id, deployment_id, trigger, evaluated_at, decision, reason,
            from_definition_id, to_definition_id, actor_fingerprint, prefix_hash, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [actorId, orgId ?? 'default', deploymentId ?? null, trigger, Number(evaluatedAt),
         decision, reason, fromDefinitionId ?? null, toDefinitionId ?? null,
         actorFingerprint, prefixHash, Date.now()]
      );
      return;
    }
    getDb().prepare(`
      INSERT INTO migration_decisions
        (actor_id, org_id, deployment_id, trigger, evaluated_at, decision, reason,
         from_definition_id, to_definition_id, actor_fingerprint, prefix_hash, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      actorId, orgId ?? 'default', deploymentId ?? null, trigger, Number(evaluatedAt),
      decision, reason,
      fromDefinitionId ?? null, toDefinitionId ?? null,
      actorFingerprint, prefixHash, Date.now()
    );
  } catch (e) {
    console.warn(`[jobRepo] decision log failed for ${actorId}: ${e.message}`);
  }
}

export async function findDecisionsByActor(actorId, orgId, { limit = 50, offset = 0 } = {}) {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    return queryAll(
      `SELECT * FROM migration_decisions WHERE actor_id=$1 AND org_id=$2 ORDER BY evaluated_at DESC LIMIT $3 OFFSET $4`,
      [actorId, orgId, limit, offset]
    );
  }
  return getDb().prepare(`
    SELECT * FROM migration_decisions
    WHERE actor_id = ? AND org_id = ?
    ORDER BY evaluated_at DESC
    LIMIT ? OFFSET ?
  `).all(actorId, orgId, limit, offset);
}

export async function findDecisionsByDeployment(deploymentId, { limit = 100, offset = 0 } = {}) {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    return queryAll(
      `SELECT * FROM migration_decisions WHERE deployment_id=$1 ORDER BY evaluated_at ASC LIMIT $2 OFFSET $3`,
      [deploymentId, limit, offset]
    );
  }
  return getDb().prepare(`
    SELECT * FROM migration_decisions
    WHERE deployment_id = ?
    ORDER BY evaluated_at ASC
    LIMIT ? OFFSET ?
  `).all(deploymentId, limit, offset);
}
