/**
 * src/registry/definitionRepo.js
 *
 * SQLite/Postgres CRUD for the `definitions` table.
 * Every definition belongs to exactly one org. orgId is always explicit.
 */

import { getDb, isPostgres } from './db.js';

let stmts = null;

function getStmts() {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    insert: db.prepare(`
      INSERT INTO definitions (id, parent_id, machine_id, org_id, definition_json, compiled_json, deployed_at, status, created_at)
      VALUES (@id, @parent_id, @machine_id, @org_id, @definition_json, @compiled_json, @deployed_at, 'active', @created_at)
    `),
    findById:          db.prepare(`SELECT * FROM definitions WHERE id = ?`),
    findByMachine:     db.prepare(`SELECT * FROM definitions WHERE machine_id = ? AND org_id = ? ORDER BY deployed_at ASC`),
    findLatestInFamily: db.prepare(`
      SELECT * FROM definitions
      WHERE machine_id = ? AND org_id = ? AND status != 'deprecated' AND status != 'pruned'
      ORDER BY deployed_at DESC, created_at DESC
      LIMIT 1
    `),
    findByStatus:  db.prepare(`SELECT * FROM definitions WHERE status = ?`),
    deprecate:     db.prepare(`UPDATE definitions SET status = 'deprecated' WHERE id = ?`),
    prune:         db.prepare(`UPDATE definitions SET status = 'pruned' WHERE id = ?`),
    listByOrg:     db.prepare(`SELECT * FROM definitions WHERE org_id = ? ORDER BY deployed_at DESC LIMIT ? OFFSET ?`),
    count:         db.prepare(`SELECT COUNT(*) as cnt FROM definitions`),
    updateJson:         db.prepare(`UPDATE definitions SET definition_json = @definition_json WHERE id = @id`),
    updateCompiledJson: db.prepare(`UPDATE definitions SET compiled_json = @compiled_json WHERE id = @id`),
  };
  return stmts;
}

function rowToDefinition(row) {
  if (!row) return null;
  let compiledJson = null;
  if (row.compiled_json) {
    try { compiledJson = JSON.parse(row.compiled_json); }
    catch (e) {
      console.warn(`[StateKeep] compiled_json parse error for definition ${row.id}:`, e.message);
    }
  }
  return {
    id:             row.id,
    parentId:       row.parent_id,
    machineId:      row.machine_id,
    orgId:          row.org_id,
    definitionJson: JSON.parse(
      Buffer.isBuffer(row.definition_json)
        ? row.definition_json.toString('utf8')
        : String(row.definition_json)
    ),
    compiledJson,
    deployedAt:     row.deployed_at,
    createdAt:      row.created_at,
    status:         row.status,
  };
}

export async function createDefinition({ id, parentId, orgId, definitionJson, compiledJson, deployedAt }) {
  if (!orgId) throw new Error('orgId is required when creating a definition');
  const parent = parentId ? await findDefinitionById(parentId) : null;
  const machineId = parent?.machineId ?? parentId ?? id;
  const defJson = JSON.stringify(definitionJson);
  const createdAt = Math.floor(Date.now() / 1000);

  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(
      `INSERT INTO definitions (id, parent_id, machine_id, org_id, definition_json, deployed_at, status, created_at, compiled_json)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8)`,
      [id, parentId ?? null, machineId, orgId, defJson, deployedAt, createdAt, compiledJson ? JSON.stringify(compiledJson) : null]
    );
    return;
  }

  getStmts().insert.run({
    id,
    parent_id:       parentId ?? null,
    machine_id:      machineId,
    org_id:          orgId,
    definition_json: defJson,
    compiled_json:   compiledJson ? JSON.stringify(compiledJson) : null,
    deployed_at:     deployedAt,
    created_at:      createdAt,
  });
}

export async function findDefinitionsByMachine(machineId, orgId) {
  if (!orgId) throw new Error('orgId is required');
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    const rows = await queryAll(
      `SELECT * FROM definitions WHERE machine_id=$1 AND org_id=$2 ORDER BY deployed_at ASC`,
      [machineId, orgId]
    );
    return rows.map(rowToDefinition);
  }
  return getStmts().findByMachine.all(machineId, orgId).map(rowToDefinition);
}

export async function findLatestInFamily(machineId, orgId) {
  if (!orgId) throw new Error('orgId is required');
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    const row = await queryOne(
      `SELECT * FROM definitions
       WHERE machine_id=$1 AND org_id=$2 AND status NOT IN ('deprecated','pruned')
       ORDER BY deployed_at DESC, created_at DESC LIMIT 1`,
      [machineId, orgId]
    );
    return rowToDefinition(row);
  }
  return rowToDefinition(getStmts().findLatestInFamily.get(machineId, orgId));
}

export async function findDefinitionById(id) {
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    return rowToDefinition(await queryOne(`SELECT * FROM definitions WHERE id=$1`, [id]));
  }
  return rowToDefinition(getStmts().findById.get(id));
}

export async function updateDefinitionJson(id, definitionJson) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`UPDATE definitions SET definition_json=$1 WHERE id=$2`, [JSON.stringify(definitionJson), id]);
    return;
  }
  getStmts().updateJson.run({ id, definition_json: JSON.stringify(definitionJson) });
}

export async function updateCompiledJson(definitionId, compiledJson) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`UPDATE definitions SET compiled_json = $1 WHERE id = $2`,
      [JSON.stringify(compiledJson), definitionId]);
    return;
  }
  getStmts().updateCompiledJson.run({ id: definitionId, compiled_json: JSON.stringify(compiledJson) });
}

export async function deprecateDefinition(id) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`UPDATE definitions SET status='deprecated' WHERE id=$1`, [id]);
    return;
  }
  getStmts().deprecate.run(id);
}

export async function listDefinitions({ limit = 50, offset = 0, orgId } = {}) {
  if (!orgId) throw new Error('orgId is required');
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    const rows = await queryAll(
      `SELECT * FROM definitions WHERE org_id=$1 ORDER BY deployed_at DESC LIMIT $2 OFFSET $3`,
      [orgId, limit, offset]
    );
    return rows.map(rowToDefinition);
  }
  return getStmts().listByOrg.all(orgId, limit, offset).map(rowToDefinition);
}
