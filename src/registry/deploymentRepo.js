/**
 * src/registry/deploymentRepo.js
 * SQLite CRUD for the `deployments` table.
 * Every deployment belongs to exactly one org. orgId is always explicit.
 */

import { getDb } from './db.js';
import { randomUUID } from 'crypto';

let stmts = null;

function getStmts() {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    insert: db.prepare(`
      INSERT INTO deployments
        (id, definition_id, org_id, status, affected_actors, migrated_count, failed_count, started_at)
      VALUES
        (@id, @definition_id, @org_id, 'pending', @affected_actors, 0, 0, @started_at)
    `),
    findById:          db.prepare(`SELECT * FROM deployments WHERE id = ?`),
    findByDef:         db.prepare(`SELECT * FROM deployments WHERE definition_id = ? ORDER BY started_at DESC`),
    updateStatus:      db.prepare(`UPDATE deployments SET status = @status, completed_at = @completed_at WHERE id = @id`),
    incrementMigrated: db.prepare(`UPDATE deployments SET migrated_count = migrated_count + 1 WHERE id = ?`),
    incrementFailed:   db.prepare(`UPDATE deployments SET failed_count   = failed_count   + 1 WHERE id = ?`),
    listByOrg:         db.prepare(`SELECT * FROM deployments WHERE org_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?`),
  };
  return stmts;
}

export function createDeployment({ definitionId, affectedActors, orgId }) {
  if (!orgId) throw new Error('orgId is required when creating a deployment');
  const id = randomUUID();
  getStmts().insert.run({
    id,
    definition_id:   definitionId,
    org_id:          orgId,
    affected_actors: affectedActors,
    started_at:      Date.now(),
  });
  return id;
}

export function findDeploymentById(id) {
  return getStmts().findById.get(id) ?? null;
}

export function findDeploymentsByDefinition(definitionId) {
  return getStmts().findByDef.all(definitionId);
}

export function updateDeploymentStatus(id, status) {
  getStmts().updateStatus.run({ id, status, completed_at: status === 'complete' || status === 'failed' ? Date.now() : null });
}

export function incrementMigrated(id) { getStmts().incrementMigrated.run(id); }
export function incrementFailed(id)   { getStmts().incrementFailed.run(id); }

export function listDeployments({ limit = 50, offset = 0, orgId } = {}) {
  if (!orgId) throw new Error('orgId is required');
  return getStmts().listByOrg.all(orgId, limit, offset);
}
