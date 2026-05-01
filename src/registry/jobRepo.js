/**
 * src/registry/jobRepo.js
 * SQLite CRUD for the `migration_jobs` job queue.
 * Jobs carry org_id so migrate-worker can pass it to repo calls.
 */

import { getDb } from './db.js';

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
      UPDATE migration_jobs
      SET status = 'done', updated_at = ?
      WHERE id = ?
    `),
    markFailed: db.prepare(`
      UPDATE migration_jobs
      SET status = 'failed', error_message = ?, updated_at = ?
      WHERE id = ?
    `),
    pendingCount:  db.prepare(`SELECT COUNT(*) as cnt FROM migration_jobs WHERE status = 'pending'`),
    countByStatus: db.prepare(`SELECT status, COUNT(*) as cnt FROM migration_jobs GROUP BY status`),
  };
  return stmts;
}

/**
 * Enqueue multiple jobs in a single transaction.
 * Each job must include: { deployment_id, actor_id, org_id, target_def_id }
 */
export function enqueueJobs(jobs) {
  const db  = getDb();
  const s   = getStmts();
  const ts  = Date.now();
  const txn = db.transaction((jobs) => {
    for (const j of jobs) {
      s.insert.run({ ...j, ts });
    }
  });
  txn(jobs);
}

/**
 * Atomically claim up to `limit` pending jobs (set to 'processing').
 * Returned rows include org_id so migrate-worker can pass it downstream.
 */
export function claimBatch(limit = 100) {
  return getStmts().claimBatch.all(Date.now(), limit);
}

export function markDone(jobId) {
  getStmts().markDone.run(Date.now(), jobId);
}

export function markFailed(jobId, errorMessage) {
  getStmts().markFailed.run(errorMessage, Date.now(), jobId);
}

export function pendingCount() {
  return getStmts().pendingCount.get().cnt;
}

export function countByStatus() {
  const rows = getStmts().countByStatus.all();
  const result = {};
  for (const r of rows) result[r.status] = r.cnt;
  return result;
}

/**
 * Persist a migration decision to migration_decisions.
 */
export function logDecision({
  actorId, orgId, deploymentId = null, trigger, evaluatedAt,
  decision, reason, fromDefinitionId = null, toDefinitionId = null,
  actorFingerprint, prefixHash = '0',
}) {
  try {
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

/**
 * Query migration decisions for a single actor, scoped to an org.
 */
export function findDecisionsByActor(actorId, orgId, { limit = 50, offset = 0 } = {}) {
  return getDb().prepare(`
    SELECT * FROM migration_decisions
    WHERE actor_id = ? AND org_id = ?
    ORDER BY evaluated_at DESC
    LIMIT ? OFFSET ?
  `).all(actorId, orgId, limit, offset);
}

/**
 * Query migration decisions for a deployment.
 */
export function findDecisionsByDeployment(deploymentId, { limit = 100, offset = 0 } = {}) {
  return getDb().prepare(`
    SELECT * FROM migration_decisions
    WHERE deployment_id = ?
    ORDER BY evaluated_at ASC
    LIMIT ? OFFSET ?
  `).all(deploymentId, limit, offset);
}
