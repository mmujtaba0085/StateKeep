/**
 * src/api/routes/export.js
 *
 * GET /v1/actors/:id/export         — Single actor + full event history (JSON)
 * GET /v1/machines/:machineId/export — All actors in a machine family (JSON or CSV)
 *
 * Constraints:
 *  - context and event payloads are always decrypted before returning
 *  - Machine export is capped at 5000 actors; X-StateKeep-Export-Count header is set
 *  - CSV stateValue fields are properly escaped (compound states = JSON object strings)
 */

import { getDb, decrypt, isPostgres }              from '../../registry/db.js';
import { findActorById, getActorIdentity } from '../../registry/actorRepo.js';
import { findDefinitionsByMachine }    from '../../registry/definitionRepo.js';

const MACHINE_EXPORT_LIMIT = 5_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function decodeEvents(rows) {
  return rows.map(row => {
    let payload = null;
    if (row.event_payload) {
      try {
        const buf = Buffer.isBuffer(row.event_payload)
          ? row.event_payload
          : Buffer.from(row.event_payload);
        payload = JSON.parse(decrypt(buf).toString('utf8'));
      } catch { payload = null; }
    }
    return {
      id:          row.id,
      type:        row.event_type,
      payload,
      tick:        row.tick,
      processedAt: row.processed_at,
    };
  });
}

/** RFC-4180 CSV cell escaping. */
function csvCell(value) {
  const s = value == null ? '' : String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function stateValueToString(sv) {
  if (sv == null)               return '';
  if (typeof sv === 'string')   return sv;
  return JSON.stringify(sv);   // compound state → JSON string (may contain commas → csvCell will quote it)
}

function actorToCsvRow(actor) {
  return [
    csvCell(actor.id),
    csvCell(actor.definitionId),
    csvCell(stateValueToString(actor.stateValue)),
    csvCell(actor.status),
    csvCell(actor.createdAt),
    csvCell(actor.updatedAt),
  ].join(',');
}

function rowToActorRaw(row) {
  if (!row) return null;
  let context = null;
  if (row.context_json) {
    try {
      const buf = Buffer.isBuffer(row.context_json)
        ? row.context_json : Buffer.from(row.context_json);
      context = JSON.parse(decrypt(buf).toString('utf8'));
    } catch { context = null; }
  }
  return {
    id:                 row.id,
    definitionId:       row.definition_id,
    orgId:              row.org_id,
    stateValue:         row.state_value ? JSON.parse(row.state_value) : null,
    context,
    logicalStartTick:   row.logical_start_tick,
    historyFingerprint: row.history_fingerprint ?? '0',
    lastEventTick:      row.last_event_tick,
    status:             row.status,
    createdAt:          row.created_at,
    updatedAt:          row.updated_at,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function exportRoutes(fastify) {

  // ── GET /v1/actors/:id/export ──────────────────────────────────────────────
  fastify.get('/v1/actors/:id/export', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        properties: {
          limit:  { type: 'integer', minimum: 1, maximum: 10000, default: 1000 },
          format: { type: 'string', enum: ['json', 'csv'], default: 'json' },
        },
      },
    },
  }, async (request, reply) => {
    const { id }             = request.params;
    const { limit, format }  = request.query;

    const identity = await getActorIdentity(id);
    if (!identity || identity.orgId !== request.orgId) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    const effectiveLimit = limit ?? 1000;
    let rows;
    if (isPostgres) {
      const { queryAll } = await import('../../registry/db-postgres.js');
      rows = await queryAll(
        `SELECT id, event_type, event_payload, tick, processed_at FROM events WHERE actor_id=$1 ORDER BY id DESC LIMIT $2`,
        [id, effectiveLimit]
      );
    } else {
      rows = getDb().prepare(`
        SELECT id, event_type, event_payload, tick, processed_at
        FROM events
        WHERE actor_id = ?
        ORDER BY id DESC
        LIMIT ?
      `).all(id, effectiveLimit);
    }

    rows.reverse(); // return in chronological order

    if (format === 'csv') {
      const csvHeader = 'id,event_type,tick,processed_at\n';
      const csvRows   = rows.map(r =>
        [csvCell(r.id), csvCell(r.event_type), csvCell(r.tick), csvCell(r.processed_at)].join(',')
      ).join('\n');
      return reply
        .type('text/csv')
        .header('Content-Disposition', `attachment; filename="actor-${id}-events.csv"`)
        .send(csvHeader + csvRows);
    }

    const actor = await findActorById(id);
    return reply.send({
      actor: {
        id:                 identity.id,
        definitionId:       actor?.definitionId,
        stateValue:         actor?.stateValue,
        context:            actor?.context,
        status:             identity.status,
        logicalStartTick:   actor?.logicalStartTick,
        historyFingerprint: actor?.historyFingerprint,
        createdAt:          actor?.createdAt,
        updatedAt:          actor?.updatedAt,
      },
      events:     decodeEvents(rows),
      eventCount: rows.length,
      limited:    rows.length === effectiveLimit,
      exportedAt: new Date().toISOString(),
    });
  });

  // ── GET /v1/machines/:machineId/export ─────────────────────────────────────
  fastify.get('/v1/machines/:machineId/export', {
    schema: {
      params: {
        type: 'object',
        required: ['machineId'],
        properties: { machineId: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['json', 'csv'], default: 'json' },
        },
      },
    },
  }, async (request, reply) => {
    const { machineId } = request.params;
    const format        = request.query.format ?? 'json';
    const orgId         = request.orgId;

    // Verify the machine exists for this org (at least one definition)
    const defs = await findDefinitionsByMachine(machineId, orgId);
    if (!defs || defs.length === 0) {
      return reply.code(404).send({ error: `Machine ${machineId} not found` });
    }

    let actorRows;
    if (isPostgres) {
      const { queryAll } = await import('../../registry/db-postgres.js');
      actorRows = await queryAll(
        `SELECT a.* FROM actors a JOIN definitions d ON a.definition_id=d.id WHERE d.machine_id=$1 AND a.org_id=$2 ORDER BY a.created_at ASC LIMIT $3`,
        [machineId, orgId, MACHINE_EXPORT_LIMIT]
      );
    } else {
      actorRows = getDb().prepare(`
        SELECT a.*
        FROM actors a
        JOIN definitions d ON a.definition_id = d.id
        WHERE d.machine_id = ? AND a.org_id = ?
        ORDER BY a.created_at ASC
        LIMIT ?
      `).all(machineId, orgId, MACHINE_EXPORT_LIMIT);
    }

    const actors = actorRows.map(rowToActorRaw);

    reply.header('X-StateKeep-Export-Count', String(actors.length));

    if (format === 'csv') {
      const header = 'id,definitionId,stateValue,status,createdAt,updatedAt';
      const lines  = actors.map(actorToCsvRow);
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="machine-${machineId}.csv"`);
      return reply.send([header, ...lines].join('\n'));
    }

    // JSON — include events for each actor
    const actorIds = actors.map(a => a.id);
    let eventsByActor = new Map();

    if (actorIds.length > 0) {
      let evRows;
      if (isPostgres) {
        const { queryAll } = await import('../../registry/db-postgres.js');
        const placeholders = actorIds.map((_, i) => `$${i + 1}`).join(',');
        evRows = await queryAll(
          `SELECT actor_id, id, event_type, event_payload, tick, processed_at FROM events WHERE actor_id IN (${placeholders}) ORDER BY actor_id, id ASC`,
          actorIds
        );
      } else {
        const placeholders = actorIds.map(() => '?').join(',');
        evRows = getDb().prepare(`
          SELECT actor_id, id, event_type, event_payload, tick, processed_at
          FROM events
          WHERE actor_id IN (${placeholders})
          ORDER BY actor_id, id ASC
        `).all(...actorIds);
      }

      for (const row of evRows) {
        if (!eventsByActor.has(row.actor_id)) eventsByActor.set(row.actor_id, []);
        eventsByActor.get(row.actor_id).push(row);
      }
    }

    const exportedActors = actors.map(actor => ({
      id:                 actor.id,
      definitionId:       actor.definitionId,
      stateValue:         actor.stateValue,
      context:            actor.context,
      status:             actor.status,
      logicalStartTick:   actor.logicalStartTick,
      historyFingerprint: actor.historyFingerprint,
      createdAt:          actor.createdAt,
      updatedAt:          actor.updatedAt,
      events:             decodeEvents(eventsByActor.get(actor.id) ?? []),
    }));

    return reply.send({
      machineId,
      actors:     exportedActors,
      count:      actors.length,
      truncated:  actors.length === MACHINE_EXPORT_LIMIT,
      exportedAt: new Date().toISOString(),
    });
  });
}
