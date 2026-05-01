/**
 * src/registry/definitionRepo.js
 *
 * SQLite CRUD for the `definitions` table.
 * Every definition belongs to exactly one org. orgId is always explicit.
 */

import { getDb } from './db.js';

let stmts = null;

function getStmts() {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    insert: db.prepare(`
      INSERT INTO definitions (id, parent_id, machine_id, org_id, definition_json, deployed_at, status)
      VALUES (@id, @parent_id, @machine_id, @org_id, @definition_json, @deployed_at, 'active')
    `),
    findById:      db.prepare(`SELECT * FROM definitions WHERE id = ?`),
    findByMachine: db.prepare(`SELECT * FROM definitions WHERE machine_id = ? AND org_id = ? ORDER BY deployed_at ASC`),
    findByStatus:  db.prepare(`SELECT * FROM definitions WHERE status = ?`),
    deprecate:     db.prepare(`UPDATE definitions SET status = 'deprecated' WHERE id = ?`),
    prune:         db.prepare(`UPDATE definitions SET status = 'pruned' WHERE id = ?`),
    listByOrg:     db.prepare(`SELECT * FROM definitions WHERE org_id = ? ORDER BY deployed_at DESC LIMIT ? OFFSET ?`),
    count:         db.prepare(`SELECT COUNT(*) as cnt FROM definitions`),
  };
  return stmts;
}

function rowToDefinition(row) {
  if (!row) return null;
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
    deployedAt:     row.deployed_at,
    status:         row.status,
  };
}

export function createDefinition({ id, parentId, orgId, definitionJson, deployedAt }) {
  if (!orgId) throw new Error('orgId is required when creating a definition');
  let machineId = id;
  if (parentId) {
    const parent = findDefinitionById(parentId);
    machineId = parent?.machineId ?? parentId;
  }
  getStmts().insert.run({
    id,
    parent_id:       parentId ?? null,
    machine_id:      machineId,
    org_id:          orgId,
    definition_json: JSON.stringify(definitionJson),
    deployed_at:     deployedAt,
  });
}

export function findDefinitionsByMachine(machineId, orgId) {
  if (!orgId) throw new Error('orgId is required');
  return getStmts().findByMachine.all(machineId, orgId).map(rowToDefinition);
}

export function findDefinitionById(id) {
  return rowToDefinition(getStmts().findById.get(id));
}

export function deprecateDefinition(id) {
  getStmts().deprecate.run(id);
}

export function listDefinitions({ limit = 50, offset = 0, orgId } = {}) {
  if (!orgId) throw new Error('orgId is required');
  return getStmts().listByOrg.all(orgId, limit, offset).map(rowToDefinition);
}
