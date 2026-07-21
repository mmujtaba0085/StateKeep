/**
 * src/registry/deploymentRepo.js
 * SQLite/Postgres CRUD for the `deployments` table.
 */

import { getDb, isPostgres } from './db.js';
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

export async function createDeployment({ definitionId, affectedActors, orgId }) {
  if (!orgId) throw new Error('orgId is required when creating a deployment');
  const id = randomUUID();
  const ts = Date.now();

  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(
      `INSERT INTO deployments
         (id, definition_id, org_id, status, affected_actors, migrated_count, failed_count, started_at)
       VALUES ($1,$2,$3,'pending',$4,0,0,$5)`,
      [id, definitionId, orgId, affectedActors, ts]
    );
    return id;
  }

  getStmts().insert.run({ id, definition_id: definitionId, org_id: orgId, affected_actors: affectedActors, started_at: ts });
  return id;
}

export async function findDeploymentById(id) {
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    return (await queryOne(`SELECT * FROM deployments WHERE id=$1`, [id])) ?? null;
  }
  return getStmts().findById.get(id) ?? null;
}

export async function findDeploymentsByDefinition(definitionId) {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    return queryAll(`SELECT * FROM deployments WHERE definition_id=$1 ORDER BY started_at DESC`, [definitionId]);
  }
  return getStmts().findByDef.all(definitionId);
}

export async function updateDeploymentStatus(id, status) {
  const completedAt = (status === 'complete' || status === 'failed') ? Date.now() : null;
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`UPDATE deployments SET status=$1, completed_at=$2 WHERE id=$3`, [status, completedAt, id]);
    return;
  }
  getStmts().updateStatus.run({ id, status, completed_at: completedAt });
}

export async function incrementMigrated(id) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`UPDATE deployments SET migrated_count = migrated_count + 1 WHERE id=$1`, [id]);
    return;
  }
  getStmts().incrementMigrated.run(id);
}

export async function incrementFailed(id) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`UPDATE deployments SET failed_count = failed_count + 1 WHERE id=$1`, [id]);
    return;
  }
  getStmts().incrementFailed.run(id);
}

export async function listDeployments({ limit = 50, offset = 0, orgId } = {}) {
  if (!orgId) throw new Error('orgId is required');
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    return queryAll(
      `SELECT * FROM deployments WHERE org_id=$1 ORDER BY started_at DESC LIMIT $2 OFFSET $3`,
      [orgId, limit, offset]
    );
  }
  return getStmts().listByOrg.all(orgId, limit, offset);
}
