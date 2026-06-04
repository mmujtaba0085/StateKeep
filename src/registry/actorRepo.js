/**
 * src/registry/actorRepo.js
 *
 * All SQLite CRUD for the `actors` table.
 * context_json is stored AES-256-GCM encrypted.
 * history_fingerprint is stored as a hex string (uint64 → hex).
 * Every actor belongs to exactly one org (org_id). orgId is always explicit.
 */

import { getDb, encrypt, decrypt } from './db.js';
import { randomUUID } from 'crypto';

function now() { return Date.now(); }

// ── Helpers ──────────────────────────────────────────────────────────────────

function rowToActor(row) {
  if (!row) return null;
  let context = null;
  if (row.context_json) {
    try {
      const buf = Buffer.isBuffer(row.context_json)
        ? row.context_json : Buffer.from(row.context_json);
      context = JSON.parse(decrypt(buf).toString('utf8'));
    } catch { context = null; }
  }
  let regionFingerprints = null;
  if (row.region_fingerprints) {
    try { regionFingerprints = JSON.parse(row.region_fingerprints); } catch {}
  }
  return {
    id:                  row.id,
    definitionId:        row.definition_id,
    orgId:               row.org_id,
    stateValue:          row.state_value ? JSON.parse(row.state_value) : null,
    context,
    logicalStartTick:    row.logical_start_tick,
    historyFingerprint:  row.history_fingerprint ?? '0',
    regionFingerprints,
    lastEventTick:       row.last_event_tick,
    status:              row.status,
    createdAt:           row.created_at,
    updatedAt:           row.updated_at,
  };
}

// ── Prepared statements (lazy) ───────────────────────────────────────────────

let stmts = null;

function getStmts() {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    insert: db.prepare(`
      INSERT INTO actors
        (id, definition_id, org_id, state_value, context_json,
         logical_start_tick, history_fingerprint, last_event_tick,
         status, created_at, updated_at)
      VALUES
        (@id, @definition_id, @org_id, @state_value, @context_json,
         @logical_start_tick, @history_fingerprint, @last_event_tick,
         @status, @created_at, @updated_at)
    `),
    findById: db.prepare(`
      SELECT * FROM actors WHERE id = ?
    `),
    updateState: db.prepare(`
      UPDATE actors
      SET state_value          = @state_value,
          context_json         = @context_json,
          history_fingerprint  = @history_fingerprint,
          region_fingerprints  = @region_fingerprints,
          last_event_tick      = @last_event_tick,
          status               = @status,
          updated_at           = @updated_at
      WHERE id = @id
    `),
    updateStatus: db.prepare(`
      UPDATE actors SET status = @status, updated_at = @updated_at WHERE id = @id
    `),
    updateDefinition: db.prepare(`
      UPDATE actors
      SET definition_id = @definition_id,
          state_value   = @state_value,
          context_json  = @context_json,
          region_fingerprints = @region_fingerprints,
          status        = 'active',
          updated_at    = @updated_at
      WHERE id = @id
    `),
    findByDefinitionAndOrg: db.prepare(`
      SELECT * FROM actors WHERE definition_id = ? AND org_id = ? AND status = 'active'
    `),
    findIdleAllOrgs: db.prepare(`
      SELECT * FROM actors
      WHERE status = 'active'
        AND updated_at < ?
      LIMIT ?
    `),
    countByStatus: db.prepare(`
      SELECT status, COUNT(*) as cnt FROM actors GROUP BY status
    `),
    listByOrg: db.prepare(`
      SELECT * FROM actors
      WHERE org_id = @org_id
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `),
    searchByOrgStatus: db.prepare(`
      SELECT * FROM actors
      WHERE org_id = @org_id
        AND status = @status
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `),
    searchByOrgDef: db.prepare(`
      SELECT * FROM actors
      WHERE org_id = @org_id
        AND definition_id = @definition_id
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `),
    searchByOrgBoth: db.prepare(`
      SELECT * FROM actors
      WHERE org_id = @org_id
        AND status = @status
        AND definition_id = @definition_id
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `),
  };
  return stmts;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function createActor({
  id = randomUUID(),
  definitionId,
  orgId,
  stateValue,
  context,
  logicalStartTick = 0,
  historyFingerprint = '0',
} = {}) {
  if (!orgId) throw new Error('orgId is required when creating an actor');
  const s = getStmts();
  const ts = now();
  const encContext = context != null
    ? encrypt(Buffer.from(JSON.stringify(context)))
    : null;

  s.insert.run({
    id,
    definition_id:        definitionId,
    org_id:               orgId,
    state_value:          stateValue != null ? JSON.stringify(stateValue) : null,
    context_json:         encContext,
    logical_start_tick:   logicalStartTick,
    history_fingerprint:  String(historyFingerprint),
    last_event_tick:      null,
    status:               'active',
    created_at:           ts,
    updated_at:           ts,
  });

  return id;
}

export function findActorById(id) {
  return rowToActor(getStmts().findById.get(id));
}

export function updateActorState(id, {
  stateValue,
  context,
  historyFingerprint,
  regionFingerprints,
  lastEventTick,
  status = 'active',
}) {
  const s = getStmts();
  const encContext = context != null
    ? encrypt(Buffer.from(JSON.stringify(context)))
    : null;
  s.updateState.run({
    id,
    state_value:          stateValue != null ? JSON.stringify(stateValue) : null,
    context_json:         encContext,
    history_fingerprint:  String(historyFingerprint),
    region_fingerprints:  regionFingerprints ? JSON.stringify(regionFingerprints) : null,
    last_event_tick:      lastEventTick ?? null,
    status,
    updated_at:           now(),
  });
}

export function updateActorStatus(id, status) {
  getStmts().updateStatus.run({ id, status, updated_at: now() });
}

export function migrateActorDefinition(id, { definitionId, stateValue, context, regionFingerprints }) {
  const encContext = context != null
    ? encrypt(Buffer.from(JSON.stringify(context)))
    : null;
  getStmts().updateDefinition.run({
    id,
    definition_id: definitionId,
    state_value:   stateValue != null ? JSON.stringify(stateValue) : null,
    context_json:  encContext,
    region_fingerprints: regionFingerprints ? JSON.stringify(regionFingerprints) : null,
    updated_at:    now(),
  });
}

export function findActorsByDefinition(definitionId, orgId) {
  if (!orgId) throw new Error('orgId is required');
  return getStmts().findByDefinitionAndOrg.all(definitionId, orgId).map(rowToActor);
}

/**
 * Find all migratable actors across ALL versions of a machine family, scoped to an org.
 * Includes needs_rescue so that rescue deployments can find and migrate stranded actors.
 */
export function findActorsByMachine(machineId, orgId) {
  if (!orgId) throw new Error('orgId is required');
  return getDb().prepare(`
    SELECT a.* FROM actors a
    JOIN definitions d ON a.definition_id = d.id
    WHERE d.machine_id = ? AND a.org_id = ? AND a.status IN ('active', 'needs_rescue')
    ORDER BY a.created_at ASC
  `).all(machineId, orgId).map(rowToActor);
}

/**
 * Find actors idle longer than `idleMs` milliseconds across ALL orgs.
 * Used by gc-worker which handles all orgs; actor.orgId is set in the result.
 */
export function findIdleActors(idleMs, limit = 100) {
  const cutoff = now() - idleMs;
  return getStmts().findIdleAllOrgs.all(cutoff, limit).map(rowToActor);
}

export function countByStatus() {
  const rows = getStmts().countByStatus.all();
  const result = {};
  for (const r of rows) result[r.status] = r.cnt;
  return result;
}

export function listActors({ limit = 50, offset = 0, status, definitionId, orgId } = {}) {
  if (!orgId) throw new Error('orgId is required');
  const s = getStmts();
  if (!status && !definitionId) {
    return s.listByOrg.all({ org_id: orgId, limit, offset }).map(rowToActor);
  }
  if (status && definitionId) {
    return s.searchByOrgBoth.all({ org_id: orgId, status, definition_id: definitionId, limit, offset }).map(rowToActor);
  }
  if (status) {
    return s.searchByOrgStatus.all({ org_id: orgId, status, limit, offset }).map(rowToActor);
  }
  return s.searchByOrgDef.all({ org_id: orgId, definition_id: definitionId, limit, offset }).map(rowToActor);
}

/**
 * Find actors on `definitionId` whose current state_value is NOT in `validStates`.
 */
export function findStrandedActors(definitionId, validStates, orgId) {
  if (!orgId) throw new Error('orgId is required');
  const db = getDb();
  const actors = db.prepare(`
    SELECT id, state_value FROM actors
    WHERE definition_id = ? AND org_id = ? AND status = 'active'
  `).all(definitionId, orgId);

  const groups = new Map();
  for (const row of actors) {
    let sv;
    try { sv = row.state_value ? JSON.parse(row.state_value) : null; } catch { sv = row.state_value; }
    const key = typeof sv === 'string' ? sv : JSON.stringify(sv);
    if (!groups.has(key)) groups.set(key, { state: key, count: 0, actorIds: [] });
    groups.get(key).count++;
    groups.get(key).actorIds.push(row.id);
  }

  const stranded = [];
  for (const [key, group] of groups) {
    let isStranded = false;
    try {
      const parsed = JSON.parse(key);
      if (typeof parsed === 'object' && parsed !== null) {
        const topLevel = Object.keys(parsed)[0];
        isStranded = topLevel !== undefined && !validStates.includes(topLevel);
      } else {
        isStranded = !validStates.includes(String(parsed));
      }
    } catch {
      isStranded = !validStates.includes(key);
    }
    if (isStranded) stranded.push(group);
  }
  return stranded;
}

/**
 * Tag a list of actors as needs_rescue in a single transaction.
 */
export function bulkTagNeedsRescue(actorIds) {
  if (!actorIds.length) return;
  const db  = getDb();
  const ts  = Date.now();
  const upd = db.prepare(`UPDATE actors SET status = 'needs_rescue', updated_at = ? WHERE id = ?`);
  const run = db.transaction(() => {
    for (const id of actorIds) upd.run(ts, id);
  });
  run();
}

/**
 * Find all actors with status = needs_rescue, scoped to an org.
 */
export function findNeedsRescueActors({ definitionId, orgId, limit = 100, offset = 0 } = {}) {
  if (!orgId) throw new Error('orgId is required');
  const db = getDb();
  if (definitionId) {
    return db.prepare(`
      SELECT * FROM actors
      WHERE status = 'needs_rescue' AND org_id = ? AND definition_id = ?
      ORDER BY updated_at DESC LIMIT ? OFFSET ?
    `).all(orgId, definitionId, limit, offset).map(rowToActor);
  }
  return db.prepare(`
    SELECT * FROM actors
    WHERE status = 'needs_rescue' AND org_id = ?
    ORDER BY updated_at DESC LIMIT ? OFFSET ?
  `).all(orgId, limit, offset).map(rowToActor);
}

export function deleteActor(id) {
  getDb().prepare(`DELETE FROM actors WHERE id = ?`).run(id);
}

/**
 * Cheapest org-isolation check — reads only id/org_id/status, no context decrypt.
 * Use this in hot-path route handlers that only need to verify ownership.
 * Returns { id, orgId, status } or null.
 */
export function getActorIdentity(id) {
  const row = getDb().prepare(
    `SELECT id, org_id, status FROM actors WHERE id = ?`
  ).get(id);
  if (!row) return null;
  return { id: row.id, orgId: row.org_id, status: row.status };
}

/**
 * Cheap single-column lookup used by the stale-cache check in actorManager.sendEvent.
 * Returns { id, definitionId } or null.
 */
export function getActorDefinitionId(id) {
  const row = getDb().prepare(
    `SELECT id, definition_id as definitionId FROM actors WHERE id = ?`
  ).get(id);
  return row ?? null;
}

/**
 * Update logical_start_tick after an actor migrates to a new definition.
 * This prevents the APV engine from routing the actor backward to an older definition.
 */
export function updateActorLogicalStartTick(id, tick) {
  getDb().prepare(
    `UPDATE actors SET logical_start_tick = ?, updated_at = ? WHERE id = ?`
  ).run(tick, Date.now(), id);
}

/**
 * Count actors grouped by status for a specific org.
 */
export function getActorCountsByStatus(orgId) {
  const rows = getDb().prepare(`
    SELECT status, COUNT(*) as cnt FROM actors WHERE org_id = ? GROUP BY status
  `).all(orgId);
  const result = { active: 0, migrating: 0, terminated: 0, archived: 0, needs_rescue: 0 };
  for (const r of rows) result[r.status] = r.cnt;
  return result;
}

/**
 * Count active actors for an org (for org deletion check).
 */
export function countActiveActors(orgId) {
  return getDb().prepare(`
    SELECT COUNT(*) as cnt FROM actors WHERE org_id = ? AND status = 'active'
  `).get(orgId)?.cnt ?? 0;
}
