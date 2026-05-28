/**
 * src/api/routes/actors.js
 *
 * POST   /v1/actors                  — Spawn actor
 * POST   /v1/actors/:id/event        — Send event
 * GET    /v1/actors/:id/state        — Current state snapshot
 * GET    /v1/actors/:id/events       — Event history (paginated)
 * DELETE /v1/actors/:id              — Terminate actor
 * GET    /v1/actors                  — List actors (dashboard)
 */

import { spawnActor, sendEvent, getActorState, terminateActor } from '../../runtime/actorManager.js';
import { getWriteBuffer } from '../../runtime/writeBuffer.js';
import { findActorById, getActorIdentity, listActors, findNeedsRescueActors, updateActorStatus, getActorCountsByStatus } from '../../registry/actorRepo.js';
import { findDefinitionById, findLatestInFamily } from '../../registry/definitionRepo.js';
import { findDecisionsByActor } from '../../registry/jobRepo.js';
import { cancelAllPendingForActor } from '../../registry/scheduledEventRepo.js';
import { getDb } from '../../registry/db.js';
import { getEngine } from '../../ffi/engine.js';
import { encrypt, decrypt } from '../../registry/db.js';
import { notifyStateChange } from '../websocket.js';

const latencies = [];
function recordLatency(ms) {
  latencies.push(ms);
  if (latencies.length > 10000) latencies.shift();
}
export function getLatencies() { return latencies; }

export async function actorRoutes(fastify) {

  // ── POST /v1/actors ────────────────────────────────────────────────────────
  fastify.post('/v1/actors', {
    schema: {
      body: {
        type: 'object',
        required: ['definitionId'],
        properties: {
          definitionId:   { type: 'string' },
          initialContext: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const t0  = Date.now();
    const eng = getEngine();
    const tick = eng.clockTick();

    // Resolve machineId alias → latest active version in that family.
    // Triggers when: (a) exact ID not found, OR (b) user passed the family root
    // ID (id === machineId), meaning "always give me the newest version".
    const rawDefinitionId = request.body.definitionId;
    let resolvedDefinitionId = rawDefinitionId;
    const exactDef = findDefinitionById(rawDefinitionId);
    if (!exactDef || exactDef.machineId === rawDefinitionId) {
      const latest = findLatestInFamily(rawDefinitionId, request.orgId);
      if (latest) resolvedDefinitionId = latest.id;
    }

    try {
      const result = await spawnActor({
        definitionId:     resolvedDefinitionId,
        orgId:            request.orgId,
        initialContext:   request.body.initialContext ?? {},
        logicalStartTick: Number(tick),
      });

      getWriteBuffer().queueEvent({
        actor_id:        result.id,
        org_id:          request.orgId,
        event_type:      'SPAWN',
        event_payload:   null,
        tick:            Number(tick),
        processed_at:    Date.now(),
        idempotency_key: null,
      });

      recordLatency(Date.now() - t0);
      return reply.code(201).send({
        id:              result.id,
        definitionId:    resolvedDefinitionId,
        requestedAs:     rawDefinitionId !== resolvedDefinitionId ? rawDefinitionId : undefined,
        stateValue:      result.stateValue,
        context:         result.context,
        done:            result.done ?? false,
      });
    } catch (err) {
      recordLatency(Date.now() - t0);
      request.log.error(err);
      const code = err.statusCode === 404 ? 404 : 400;
      return reply.code(code).send({ error: err.message });
    }
  });

  // ── POST /v1/actors/:id/event ──────────────────────────────────────────────
  fastify.post('/v1/actors/:id/event', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['type'],
        properties: {
          type:           { type: 'string', minLength: 1 },
          payload:        { type: 'object' },
          idempotencyKey: { type: 'string', maxLength: 128, pattern: '^[a-zA-Z0-9_\\-:.]+$' },
        },
      },
    },
  }, async (request, reply) => {
    const t0    = Date.now();
    const eng   = getEngine();
    const tick  = eng.clockTick();
    const { id } = request.params;

    // Org isolation check — no context decrypt needed here, use lightweight lookup
    const actor = getActorIdentity(id);
    if (!actor || actor.orgId !== request.orgId) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    const { type: eventType, payload, idempotencyKey } = request.body;

    // ── Idempotency check ─────────────────────────────────────────────────────
    if (idempotencyKey) {
      // Check write buffer first (event processed but not yet flushed to DB)
      const inFlight = getWriteBuffer().hasPendingEvent(id, idempotencyKey);
      const inDb = !inFlight && !!getDb().prepare(
        `SELECT e.id FROM events e WHERE e.actor_id = ? AND e.org_id = ? AND e.idempotency_key = ?`
      ).get(id, request.orgId, idempotencyKey);

      if (inFlight || inDb) {
        const snap = inFlight ? await getActorState(id) : null;
        const current = snap ?? findActorById(id);
        recordLatency(Date.now() - t0);
        return reply.code(200).send({
          actorId:            id,
          definitionId:       current.definitionId,
          stateValue:         current.stateValue,
          context:            current.context,
          status:             current.status,
          historyFingerprint: current.historyFingerprint,
          done:               current.status === 'terminated',
          idempotent:         true,
        });
      }
    }

    const event    = { type: eventType, ...(payload ?? {}) };
    const _pri     = request.headers['x-priority'];
    const priority = _pri === 'urgent' ? 'urgent' : _pri === 'high' ? 'high' : 'normal';

    try {
      const encPayload = payload
        ? encrypt(Buffer.from(JSON.stringify(payload)))
        : null;
      const tickNum = Number(tick);
      const orgId   = request.orgId;

      const result = await sendEvent(id, event, tickNum, {
        priority,
        orgId,
        eventData: {
          actor_id:        id,
          org_id:          orgId,
          event_type:      event.type,
          event_payload:   encPayload,
          tick:            tickNum,
          processed_at:    Date.now(),
          idempotency_key: idempotencyKey ?? null,
        },
      });

      // Notify WebSocket subscribers
      notifyStateChange(id, result.stateValue, result.context);

      recordLatency(Date.now() - t0);
      return reply.send({
        actorId:    id,
        stateValue: result.stateValue,
        context:    result.context,
        done:       result.done,
        migratedTo: result.migratedTo ?? null,
      });
    } catch (err) {
      recordLatency(Date.now() - t0);
      request.log.error(err);
      let code = 400;
      if (err.message.includes('not found')) code = 404;
      if (err.code === 'ACTOR_NEEDS_RESCUE')  code = 409;
      return reply.code(code).send({
        error:  err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
  });

  // ── GET /v1/actors/:id — convenience alias for /state ────────────────────
  // Scripts (spawn-tickets.js, spawn-loans.js) and external clients call the
  // bare /:id path. Fastify's radix tree gives static suffixes priority, so
  // registering this before /state is safe.
  fastify.get('/v1/actors/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const actor = getActorIdentity(id);
    if (!actor || actor.orgId !== request.orgId) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }
    try {
      const _pri3   = request.headers['x-priority'];
      const priority = _pri3 === 'urgent' ? 'urgent' : _pri3 === 'high' ? 'high' : 'normal';
      const state = await getActorState(id, { priority });
      return reply.send({
        ...state,
        id,
        done: state.status === 'terminated' ||
              (state.stateValue != null && typeof state.stateValue === 'string' && state.stateValue === 'done'),
      });
    } catch (err) {
      const code = err.message.includes('not found') ? 404 : 500;
      return reply.code(code).send({ error: err.message });
    }
  });

  // ── GET /v1/actors/:id/state ───────────────────────────────────────────────
  fastify.get('/v1/actors/:id/state', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const t0 = Date.now();
    const { id } = request.params;

    const actor = getActorIdentity(id);
    if (!actor || actor.orgId !== request.orgId) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    try {
      const state = await getActorState(id);
      recordLatency(Date.now() - t0);
      return reply.send({
        ...state,
        done: state.status === 'terminated' ||
              (state.stateValue != null && typeof state.stateValue === 'string' && state.stateValue === 'done'),
      });
    } catch (err) {
      recordLatency(Date.now() - t0);
      const code = err.message.includes('not found') ? 404 : 500;
      return reply.code(code).send({ error: err.message });
    }
  });

  // ── GET /v1/actors/:id/events — cursor-paginated event history ───────────────
  fastify.get('/v1/actors/:id/events', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      querystring: {
        type: 'object',
        properties: {
          limit:   { type: 'integer', default: 50, minimum: 1, maximum: 200 },
          after:   { type: 'integer', minimum: 0 },
          // afterId is kept for backward compatibility — deprecated
          afterId: { type: 'integer', default: 0, minimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const actor = getActorIdentity(id);
    if (!actor || actor.orgId !== request.orgId) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    const db    = getDb();
    const limit = Math.min(request.query.limit ?? 50, 200);

    // `after` is the preferred cursor param; `afterId` is backward-compat alias
    const after = request.query.after ?? request.query.afterId ?? 0;

    // Fetch limit+1 to detect hasMore without a COUNT query
    const rows = db.prepare(`
      SELECT id, event_type, event_payload, tick, processed_at
      FROM events
      WHERE actor_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(id, after, limit + 1);

    const hasMore   = rows.length > limit;
    const pageRows  = hasMore ? rows.slice(0, limit) : rows;

    const events = pageRows.map(row => {
      let payload = null;
      if (row.event_payload) {
        try {
          const buf = Buffer.isBuffer(row.event_payload) ? row.event_payload : Buffer.from(row.event_payload);
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

    const nextCursor = hasMore ? pageRows[pageRows.length - 1].id : null;
    return reply.send({ actorId: id, events, total: events.length, limit, after, hasMore, nextCursor });
  });

  // ── DELETE /v1/actors/:id ──────────────────────────────────────────────────
  fastify.delete('/v1/actors/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const actor = getActorIdentity(id);
    if (!actor || actor.orgId !== request.orgId) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    try {
      const _pri2    = request.headers['x-priority'];
      const priority = _pri2 === 'urgent' ? 'urgent' : _pri2 === 'high' ? 'high' : 'normal';
      const cancelled = cancelAllPendingForActor(id, request.orgId);
      await terminateActor(id, { priority, orgId: request.orgId });
      return reply.code(200).send({ cancelled });
    } catch (err) {
      const code = err.message.includes('not found') ? 404 : 500;
      return reply.code(code).send({ error: err.message });
    }
  });

  // ── GET /v1/actors/needs-rescue ──────────────────────────────────────────────
  fastify.get('/v1/actors/needs-rescue', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit:        { type: 'integer', default: 50, minimum: 1, maximum: 200 },
          offset:       { type: 'integer', default: 0 },
          definitionId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { limit, offset, definitionId } = request.query;
    const actors = findNeedsRescueActors({ limit, offset, definitionId, orgId: request.orgId });
    return reply.send({
      actors,
      count: actors.length,
      message: actors.length > 0
        ? 'These actors are stranded in states that no longer exist in their definition. Deploy a rescue version to unblock them.'
        : 'No actors currently need rescue.',
    });
  });

  // ── GET /v1/actors/:id/decisions ──────────────────────────────────────────
  fastify.get('/v1/actors/:id/decisions', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      querystring: {
        type: 'object',
        properties: {
          limit:  { type: 'integer', default: 50, minimum: 1, maximum: 200 },
          offset: { type: 'integer', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const actor = getActorIdentity(id);
    if (!actor || actor.orgId !== request.orgId) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    const { limit, offset } = request.query;
    const rows = findDecisionsByActor(id, request.orgId, { limit, offset });
    const total = getDb().prepare(`SELECT COUNT(*) as cnt FROM migration_decisions WHERE actor_id = ? AND org_id = ?`).get(id, request.orgId)?.cnt ?? 0;

    const decisions = rows.map(r => ({
      id:               r.id,
      trigger:          r.trigger,
      evaluatedAt:      r.evaluated_at,
      decision:         r.decision,
      reason:           r.reason,
      fromDefinitionId: r.from_definition_id,
      toDefinitionId:   r.to_definition_id,
      actorFingerprint: r.actor_fingerprint,
      prefixHash:       r.prefix_hash,
      deploymentId:     r.deployment_id,
      createdAt:        r.created_at,
    }));

    return reply.send({ actorId: id, decisions, total, limit, offset });
  });

  // ── PATCH /v1/actors/:id — manual needs_rescue reset ──────────────────────
  fastify.patch('/v1/actors/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const actor = getActorIdentity(id);
    if (!actor || actor.orgId !== request.orgId) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    if (request.body.status !== 'active') {
      return reply.code(400).send({ error: 'Only needs_rescue → active transition is supported' });
    }
    if (actor.status !== 'needs_rescue') {
      return reply.code(409).send({ error: 'Actor is not in needs_rescue status' });
    }

    updateActorStatus(id, 'active');

    // Write system event
    const db = getDb();
    const eng  = getEngine();
    const tick = Number(eng.clockTick());
    db.prepare(`
      INSERT INTO events (actor_id, org_id, event_type, event_payload, tick, processed_at)
      VALUES (?, ?, 'MANUALLY_RESCUED', NULL, ?, ?)
    `).run(id, request.orgId, tick, Date.now());

    const updated = findActorById(id);
    return reply.code(200).send(updated);
  });

  // ── POST /v1/actors/bulk — spawn up to 500 actors in one request ────────────
  fastify.post('/v1/actors/bulk', {
    schema: {
      body: {
        type: 'object',
        required: ['actors'],
        properties: {
          actors: {
            type: 'array',
            items: {
              type: 'object',
              required: ['definitionId'],
              properties: {
                definitionId:   { type: 'string' },
                initialContext: { type: 'object' },
              },
            },
            minItems: 1,
            maxItems: 500,
          },
        },
      },
    },
  }, async (request, reply) => {
    const { actors: requests } = request.body;
    const eng  = getEngine();
    const tick = Number(eng.clockTick());
    const db   = getDb();

    // Pre-resolve all unique definitionIds to avoid N repeated DB lookups.
    // Supports machine alias: if the ID is a family root (id===machineId) or
    // doesn't match an exact definition, resolve to the latest active version.
    const resolvedIdCache = new Map();
    for (const req of requests) {
      const raw = req.definitionId;
      if (!resolvedIdCache.has(raw)) {
        const exactDef = findDefinitionById(raw);
        if (exactDef && exactDef.machineId !== raw) {
          // Explicit version ID (e.g. 'sim-loan-v2') — use as-is
          resolvedIdCache.set(raw, raw);
        } else {
          // Family root ID or not found → resolve to latest active in family
          const latest = findLatestInFamily(raw, request.orgId);
          resolvedIdCache.set(raw, latest ? latest.id : raw);
        }
      }
    }

    const created = [];
    const failed  = [];

    // Process in batches of 50 concurrent spawns
    const CONCURRENCY = 50;
    for (let i = 0; i < requests.length; i += CONCURRENCY) {
      const slice = requests.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        slice.map(req => spawnActor({
          definitionId:     resolvedIdCache.get(req.definitionId),
          orgId:            request.orgId,
          initialContext:   req.initialContext ?? {},
          logicalStartTick: tick,
        }))
      );
      for (let j = 0; j < results.length; j++) {
        const r   = results[j];
        const raw = slice[j].definitionId;
        const resolved = resolvedIdCache.get(raw);
        if (r.status === 'fulfilled') {
          const v = r.value;
          try {
            db.prepare(`
              INSERT INTO events (actor_id, org_id, event_type, event_payload, tick, processed_at)
              VALUES (?, ?, 'SPAWN', NULL, ?, ?)
            `).run(v.id, request.orgId, tick, Date.now());
          } catch {}
          created.push({
            id:          v.id,
            definitionId: resolved,
            requestedAs:  raw !== resolved ? raw : undefined,
            stateValue:   v.stateValue,
          });
        } else {
          failed.push({ index: i + j, definitionId: raw, error: r.reason?.message ?? 'spawn failed' });
        }
      }
    }

    return reply.code(207).send({ created, failed, total: requests.length });
  });

  // ── GET /v1/actors ─────────────────────────────────────────────────────────
  fastify.get('/v1/actors', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit:        { type: 'integer', default: 50 },
          offset:       { type: 'integer', default: 0 },
          status:       { type: 'string', enum: ['active','migrating','terminated','archived','needs_rescue'] },
          definitionId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { limit, offset, status, definitionId } = request.query;
    const actors = listActors({ limit, offset, status, definitionId, orgId: request.orgId });
    const counts = getActorCountsByStatus(request.orgId);
    return reply.send({
      actors,
      count:  actors.length,
      total:  counts.active + counts.migrating + counts.needs_rescue,
      counts,
    });
  });
}
