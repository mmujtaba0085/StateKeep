/**
 * src/registry/actorRepo.js
 *
 * All SQLite CRUD for the `actors` table.
 * context_json is stored AES-256-GCM encrypted.
 * history_fingerprint is stored as a hex string (uint64 → hex).
 * Every actor belongs to exactly one org (org_id). orgId is always explicit.
 */

import { getDb, encrypt, decrypt, isPostgres } from './db.js';
import {
  deserializeRegionFingerprints,
  serializeRegionFingerprints,
} from './regionFingerprintCodec.js';
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
  const regionFingerprints = deserializeRegionFingerprints(row.region_fingerprints);
  return {
    id:                  row.id,
    definitionId:        row.definition_id,
    stateValue:          row.state_value ? JSON.parse(row.state_value) : null,
    context,
    logicalStartTick:    row.logical_start_tick,
    historyFingerprint:  row.history_fingerprint ?? '0',
    regionFingerprints,
    lastEventTick:       row.last_event_tick,
    status:              row.status,
    createdAt:           row.created_at,
    updatedAt:           row.updated_at,
    stateEntryId:        row.state_entry_id ?? 0,
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
        (id, definition_id, state_value, context_json,
         logical_start_tick, history_fingerprint, last_event_tick,
         state_entry_id, status, created_at, updated_at)
      VALUES
        (@id, @definition_id, @state_value, @context_json,
         @logical_start_tick, @history_fingerprint, @last_event_tick,
         @state_entry_id, @status, @created_at, @updated_at)
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
          state_entry_id       = @state_entry_id,
          status               = @status,
          updated_at           = @updated_at
      WHERE id = @id
    `),
    updateStatus: db.prepare(`
      UPDATE actors SET status = @status, updated_at = @updated_at WHERE id = @id
    `),
    updateDefinition: db.prepare(`
      UPDATE actors
      SET definition_id       = @definition_id,
          state_value         = @state_value,
          context_json        = @context_json,
          region_fingerprints = @region_fingerprints,
          logical_start_tick  = @logical_start_tick,
          status              = 'active',
          updated_at          = @updated_at
      WHERE id = @id
    `),
    findByDefinition: db.prepare(`
      SELECT * FROM actors WHERE definition_id = ? AND status = 'active'
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
    list: db.prepare(`
      SELECT * FROM actors
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `),
    listByStatus: db.prepare(`
      SELECT * FROM actors
      WHERE status = @status
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `),
    listByDef: db.prepare(`
      SELECT * FROM actors
      WHERE definition_id = @definition_id
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `),
    listByBoth: db.prepare(`
      SELECT * FROM actors
      WHERE status = @status
        AND definition_id = @definition_id
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `),
  };
  return stmts;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function createActor({
  id = randomUUID(),
  definitionId,
  stateValue,
  context,
  logicalStartTick = 0,
  historyFingerprint = '0',
  stateEntryId = 0,
} = {}) {
  const ts = now();
  const encContext = context != null
    ? encrypt(Buffer.from(JSON.stringify(context)))
    : null;

  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(
      `INSERT INTO actors
         (id, definition_id, state_value, context_json,
          logical_start_tick, history_fingerprint, last_event_tick,
          state_entry_id, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, definitionId,
       stateValue != null ? JSON.stringify(stateValue) : null,
       encContext, logicalStartTick, String(historyFingerprint),
       null, stateEntryId ?? 0, 'active', ts, ts]
    );
    return id;
  }

  const s = getStmts();
  s.insert.run({
    id,
    definition_id:        definitionId,
    state_value:          stateValue != null ? JSON.stringify(stateValue) : null,
    context_json:         encContext,
    logical_start_tick:   logicalStartTick,
    history_fingerprint:  String(historyFingerprint),
    last_event_tick:      null,
    state_entry_id:       stateEntryId ?? 0,
    status:               'active',
    created_at:           ts,
    updated_at:           ts,
  });
  return id;
}

export async function findActorById(id) {
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    return rowToActor(await queryOne('SELECT * FROM actors WHERE id=$1', [id]));
  }
  return rowToActor(getStmts().findById.get(id));
}

export async function updateActorState(id, {
  stateValue,
  context,
  historyFingerprint,
  regionFingerprints,
  lastEventTick,
  status = 'active',
  stateEntryId,
}) {
  const encContext = context != null
    ? encrypt(Buffer.from(JSON.stringify(context)))
    : null;

  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(
      `UPDATE actors SET
         state_value=$1, context_json=$2, history_fingerprint=$3,
         region_fingerprints=$4, last_event_tick=$5, status=$6, updated_at=$7,
         state_entry_id=$8
       WHERE id=$9`,
      [stateValue != null ? JSON.stringify(stateValue) : null,
       encContext, String(historyFingerprint),
       serializeRegionFingerprints(regionFingerprints),
       lastEventTick ?? null, status, now(), stateEntryId ?? 0, id]
    );
    return;
  }

  const s = getStmts();
  s.updateState.run({
    id,
    state_value:          stateValue != null ? JSON.stringify(stateValue) : null,
    context_json:         encContext,
    history_fingerprint:  String(historyFingerprint),
    region_fingerprints:  serializeRegionFingerprints(regionFingerprints),
    last_event_tick:      lastEventTick ?? null,
    state_entry_id:       stateEntryId ?? 0,
    status,
    updated_at:           now(),
  });
}

export async function updateActorStatus(id, status) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query('UPDATE actors SET status=$1, updated_at=$2 WHERE id=$3', [status, now(), id]);
    return;
  }
  getStmts().updateStatus.run({ id, status, updated_at: now() });
}

export async function migrateActorDefinition(id, { definitionId, stateValue, context, regionFingerprints, logicalStartTick, stateEntryId }) {
  const encContext = context != null
    ? encrypt(Buffer.from(JSON.stringify(context)))
    : null;

  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(
      `UPDATE actors SET
         definition_id=$1, state_value=$2, context_json=$3,
         region_fingerprints=$4, logical_start_tick=$5, state_entry_id=$6,
         status='active', updated_at=$7
       WHERE id=$8`,
      [definitionId,
       stateValue != null ? JSON.stringify(stateValue) : null,
       encContext, serializeRegionFingerprints(regionFingerprints),
       logicalStartTick ?? 0, stateEntryId ?? 0, now(), id]
    );
    return;
  }

  getStmts().updateDefinition.run({
    id,
    definition_id:       definitionId,
    state_value:         stateValue != null ? JSON.stringify(stateValue) : null,
    context_json:        encContext,
    region_fingerprints: serializeRegionFingerprints(regionFingerprints),
    logical_start_tick:  logicalStartTick ?? 0,
    updated_at:          now(),
  });
}

export async function findActorsByDefinition(definitionId) {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    const rows = await queryAll(
      `SELECT * FROM actors WHERE definition_id=$1 AND status='active'`,
      [definitionId]
    );
    return rows.map(rowToActor);
  }
  return getStmts().findByDefinition.all(definitionId).map(rowToActor);
}

export async function findActorsByMachine(machineId) {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    const rows = await queryAll(
      `SELECT a.* FROM actors a
       JOIN definitions d ON a.definition_id = d.id
       WHERE d.machine_id=$1 AND a.status IN ('active','needs_rescue')
       ORDER BY a.created_at ASC`,
      [machineId]
    );
    return rows.map(rowToActor);
  }
  return getDb().prepare(`
    SELECT a.* FROM actors a
    JOIN definitions d ON a.definition_id = d.id
    WHERE d.machine_id = ? AND a.status IN ('active', 'needs_rescue')
    ORDER BY a.created_at ASC
  `).all(machineId).map(rowToActor);
}

export async function findIdleActors(idleMs, limit = 100) {
  const cutoff = now() - idleMs;
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    const rows = await queryAll(
      `SELECT * FROM actors WHERE status='active' AND updated_at<$1 LIMIT $2`,
      [cutoff, limit]
    );
    return rows.map(rowToActor);
  }
  return getStmts().findIdleAllOrgs.all(cutoff, limit).map(rowToActor);
}

export async function countByStatus() {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    const rows = await queryAll(`SELECT status, COUNT(*) as cnt FROM actors GROUP BY status`);
    const result = {};
    for (const r of rows) result[r.status] = Number(r.cnt);
    return result;
  }
  const rows = getStmts().countByStatus.all();
  const result = {};
  for (const r of rows) result[r.status] = r.cnt;
  return result;
}

export async function listActors({ limit = 50, offset = 0, status, definitionId } = {}) {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    let sql, params;
    if (!status && !definitionId) {
      sql = `SELECT * FROM actors ORDER BY created_at DESC LIMIT $1 OFFSET $2`;
      params = [limit, offset];
    } else if (status && definitionId) {
      sql = `SELECT * FROM actors WHERE status=$1 AND definition_id=$2 ORDER BY created_at DESC LIMIT $3 OFFSET $4`;
      params = [status, definitionId, limit, offset];
    } else if (status) {
      sql = `SELECT * FROM actors WHERE status=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
      params = [status, limit, offset];
    } else {
      sql = `SELECT * FROM actors WHERE definition_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
      params = [definitionId, limit, offset];
    }
    return (await queryAll(sql, params)).map(rowToActor);
  }
  const s = getStmts();
  if (!status && !definitionId) {
    return s.list.all({ limit, offset }).map(rowToActor);
  }
  if (status && definitionId) {
    return s.listByBoth.all({ status, definition_id: definitionId, limit, offset }).map(rowToActor);
  }
  if (status) {
    return s.listByStatus.all({ status, limit, offset }).map(rowToActor);
  }
  return s.listByDef.all({ definition_id: definitionId, limit, offset }).map(rowToActor);
}

export async function findStrandedActors(definitionId, validStates, orgId) {
  if (!orgId) throw new Error('orgId is required');
  let actors;
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    actors = await queryAll(
      `SELECT id, state_value FROM actors WHERE definition_id=$1 AND org_id=$2 AND status='active'`,
      [definitionId, orgId]
    );
  } else {
    actors = getDb().prepare(`
      SELECT id, state_value FROM actors
      WHERE definition_id = ? AND org_id = ? AND status = 'active'
    `).all(definitionId, orgId);
  }

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

export async function bulkTagNeedsRescue(actorIds) {
  if (!actorIds.length) return;
  const ts = Date.now();
  if (isPostgres) {
    const { transaction } = await import('./db-postgres.js');
    await transaction(async (client) => {
      for (const id of actorIds) {
        await client.query(`UPDATE actors SET status='needs_rescue', updated_at=$1 WHERE id=$2`, [ts, id]);
      }
    });
    return;
  }
  const db  = getDb();
  const upd = db.prepare(`UPDATE actors SET status = 'needs_rescue', updated_at = ? WHERE id = ?`);
  db.transaction(() => { for (const id of actorIds) upd.run(ts, id); })();
}

export async function findNeedsRescueActors({ definitionId, orgId, limit = 100, offset = 0 } = {}) {
  if (!orgId) throw new Error('orgId is required');
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    let sql, params;
    if (definitionId) {
      sql = `SELECT * FROM actors WHERE status='needs_rescue' AND org_id=$1 AND definition_id=$2 ORDER BY updated_at DESC LIMIT $3 OFFSET $4`;
      params = [orgId, definitionId, limit, offset];
    } else {
      sql = `SELECT * FROM actors WHERE status='needs_rescue' AND org_id=$1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3`;
      params = [orgId, limit, offset];
    }
    return (await queryAll(sql, params)).map(rowToActor);
  }
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

export async function deleteActor(id) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`DELETE FROM actors WHERE id=$1`, [id]);
    return;
  }
  getDb().prepare(`DELETE FROM actors WHERE id = ?`).run(id);
}

export async function getActorIdentity(id) {
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    const row = await queryOne(`SELECT id, org_id, status FROM actors WHERE id=$1`, [id]);
    if (!row) return null;
    return { id: row.id, orgId: row.org_id, status: row.status };
  }
  const row = getDb().prepare(
    `SELECT id, org_id, status FROM actors WHERE id = ?`
  ).get(id);
  if (!row) return null;
  return { id: row.id, orgId: row.org_id, status: row.status };
}

export async function getActorDefinitionId(id) {
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    const row = await queryOne(`SELECT id, definition_id FROM actors WHERE id=$1`, [id]);
    if (!row) return null;
    return { id: row.id, definitionId: row.definition_id };
  }
  const row = getDb().prepare(
    `SELECT id, definition_id as definitionId FROM actors WHERE id = ?`
  ).get(id);
  return row ?? null;
}

export async function updateActorLogicalStartTick(id, tick) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`UPDATE actors SET logical_start_tick=$1, updated_at=$2 WHERE id=$3`, [tick, Date.now(), id]);
    return;
  }
  getDb().prepare(
    `UPDATE actors SET logical_start_tick = ?, updated_at = ? WHERE id = ?`
  ).run(tick, Date.now(), id);
}

export async function getActorCountsByStatus() {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    const rows = await queryAll(
      `SELECT status, COUNT(*) as cnt FROM actors GROUP BY status`
    );
    const result = { active: 0, migrating: 0, terminated: 0, archived: 0, needs_rescue: 0 };
    for (const r of rows) result[r.status] = Number(r.cnt);
    return result;
  }
  const rows = getDb().prepare(`
    SELECT status, COUNT(*) as cnt FROM actors GROUP BY status
  `).all();
  const result = { active: 0, migrating: 0, terminated: 0, archived: 0, needs_rescue: 0 };
  for (const r of rows) result[r.status] = r.cnt;
  return result;
}

export async function countActiveActors() {
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    const row = await queryOne(
      `SELECT COUNT(*) as cnt FROM actors WHERE status='active'`
    );
    return Number(row?.cnt ?? 0);
  }
  return getDb().prepare(`
    SELECT COUNT(*) as cnt FROM actors WHERE status = 'active'
  `).get()?.cnt ?? 0;
}
