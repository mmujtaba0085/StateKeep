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
import { findActorById, listActors, findNeedsRescueActors, updateActorStatus } from '../../registry/actorRepo.js';
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
    config: {
      rateLimit: {
        max:          100,
        timeWindow:   '1 minute',
        keyGenerator: (req) => req.headers['x-api-key'] ?? req.ip,
      },
    },
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

    try {
      const result = await spawnActor({
        definitionId:     request.body.definitionId,
        orgId:            request.orgId,
        initialContext:   request.body.initialContext ?? {},
        logicalStartTick: Number(tick),
      });

      const db = getDb();
      db.prepare(`
        INSERT INTO events (actor_id, org_id, event_type, event_payload, tick, processed_at)
        VALUES (?, ?, 'SPAWN', NULL, ?, ?)
      `).run(result.id, request.orgId, Number(tick), Date.now());

      recordLatency(Date.now() - t0);
      return reply.code(201).send({
        id:           result.id,
        definitionId: request.body.definitionId,
        stateValue:   result.stateValue,
        context:      result.context,
        done:         result.done ?? false,
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
    config: {
      rateLimit: {
        max:          500,
        timeWindow:   '1 minute',
        keyGenerator: (req) => req.headers['x-api-key'] ?? req.ip,
      },
    },
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['type'],
        properties: {
          type:    { type: 'string', minLength: 1 },
          payload: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const t0    = Date.now();
    const eng   = getEngine();
    const tick  = eng.clockTick();
    const { id } = request.params;

    // Org isolation check — 404 hides existence from other orgs
    const actor = findActorById(id);
    if (!actor || actor.orgId !== request.orgId) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    const event  = { type: request.body.type, ...(request.body.payload ?? {}) };

    try {
      const result = await sendEvent(id, event, Number(tick));

      const db = getDb();
      const encPayload = request.body.payload
        ? encrypt(Buffer.from(JSON.stringify(request.body.payload)))
        : null;
      db.prepare(`
        INSERT INTO events (actor_id, org_id, event_type, event_payload, tick, processed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, request.orgId, event.type, encPayload, Number(tick), Date.now());

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
    const actor = findActorById(id);
    if (!actor || actor.orgId !== request.orgId) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }
    try {
      const state = await getActorState(id);
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

    const actor = findActorById(id);
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
          afterId: { type: 'integer', default: 0, minimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const actor = findActorById(id);
    if (!actor || actor.orgId !== request.orgId) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    const { limit, afterId } = request.query;
    const db = getDb();

    const rows = db.prepare(`
      SELECT id, event_type, event_payload, tick, processed_at
      FROM events
      WHERE actor_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(id, afterId, limit);

    const events = rows.map(row => {
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

    const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
    return reply.send({ actorId: id, events, total: events.length, limit, afterId, nextCursor });
  });

  // ── DELETE /v1/actors/:id ──────────────────────────────────────────────────
  fastify.delete('/v1/actors/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const actor = findActorById(id);
    if (!actor || actor.orgId !== request.orgId) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    try {
      const cancelled = cancelAllPendingForActor(id, request.orgId);
      await terminateActor(id);
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
    const actor = findActorById(id);
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
    const actor = findActorById(id);
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

    const created = [];
    const failed  = [];

    // Process in batches of 50 concurrent spawns
    const CONCURRENCY = 50;
    for (let i = 0; i < requests.length; i += CONCURRENCY) {
      const slice = requests.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        slice.map(req => spawnActor({
          definitionId:     req.definitionId,
          orgId:            request.orgId,
          initialContext:   req.initialContext ?? {},
          logicalStartTick: tick,
        }))
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === 'fulfilled') {
          const v = r.value;
          try {
            db.prepare(`
              INSERT INTO events (actor_id, org_id, event_type, event_payload, tick, processed_at)
              VALUES (?, ?, 'SPAWN', NULL, ?, ?)
            `).run(v.id, request.orgId, tick, Date.now());
          } catch {}
          created.push({ id: v.id, definitionId: slice[j].definitionId, stateValue: v.stateValue });
        } else {
          failed.push({ index: i + j, definitionId: slice[j].definitionId, error: r.reason?.message ?? 'spawn failed' });
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
    return reply.send({ actors, count: actors.length });
  });
}
