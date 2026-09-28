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

import { claimNew } from '../../cluster/cluster.js';
import { spawnActor, sendEvent, getActorState, terminateActor } from '../../runtime/actorManager.js';
import { getWriteBuffer } from '../../runtime/writeBuffer.js';
import { findActorById, findActorIdBySpawnKey, getActorIdentity, listActors, findNeedsRescueActors, updateActorStatus, getActorCountsByStatus } from '../../registry/actorRepo.js';
import { findDefinitionById, findLatestInFamily, findMachineIdsByName, findMaxDeployedAtInFamily } from '../../registry/definitionRepo.js';
import { findDecisionsByActor } from '../../registry/jobRepo.js';
import { cancelAllPendingForActor } from '../../registry/scheduledEventRepo.js';
import { getDb, isPostgres, encrypt, decrypt } from '../../registry/db.js';
import { getEngine } from '../../ffi/engine.js';
import { notifyStateChange } from '../websocket.js';

const LATENCY_SIZE = 10000;
const _latencyBuf  = new Int32Array(LATENCY_SIZE);
let   _latencyPtr  = 0;
let   _latencyFill = 0;

function recordLatency(ms) {
  _latencyBuf[_latencyPtr] = ms;
  _latencyPtr = (_latencyPtr + 1) % LATENCY_SIZE;
  if (_latencyFill < LATENCY_SIZE) _latencyFill++;
}

export function getLatencies() {
  if (_latencyFill < LATENCY_SIZE) return Array.from(_latencyBuf.subarray(0, _latencyFill));
  return [
    ...Array.from(_latencyBuf.subarray(_latencyPtr)),
    ...Array.from(_latencyBuf.subarray(0, _latencyPtr)),
  ];
}

// In-flight idempotency keys (`${actorId}:${key}`) → promise resolved when done.
// Single-process guard; with several API servers the DB unique index still keeps
// one event row, but see docs: run one writer per database.
const idempotencyInFlight = new Map();

/** Logical time for an actor pinned to a specific version: one past the newest deployment
 *  of its family, so later deployments apply to it and earlier ones do not. */
async function pinnedLogicalTime(definitionId) {
  const def = await findDefinitionById(definitionId);
  if (!def) return undefined;
  const newest = await findMaxDeployedAtInFamily(def.machineId ?? definitionId);
  return Math.max(newest, Number(def.deployedAt ?? 0)) + 1;
}

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
          idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
  }, async (request, reply) => {
    const t0  = Date.now();
    const eng = getEngine();
    const tick = eng.clockTick();

    // Idempotent spawn: a client that retries after a lost answer (the server crashed,
    // the connection dropped) gets the actor its first attempt created — never a second.
    const spawnKey = request.body.idempotencyKey ?? request.headers['idempotency-key'] ?? null;
    const existingFor = async (key) => {
      const id = key ? await findActorIdBySpawnKey(key) : null;
      if (!id) return null;
      const a = await getActorState(id).catch(() => null);
      return reply.code(200).send({ id, definitionId: a?.definitionId, stateValue: a?.stateValue,
        context: a?.context, done: a?.status === 'terminated', duplicate: true });
    };
    if (spawnKey) { const r = await existingFor(spawnKey); if (r) return r; }

    // Resolve machineId alias → latest active version in that family.
    // Triggers when: (a) exact ID not found, OR (b) user passed the family root
    // ID (id === machineId), meaning "always give me the newest version".
    const rawDefinitionId = request.body.definitionId;
    let resolvedDefinitionId = rawDefinitionId;
    const exactDef = await findDefinitionById(rawDefinitionId);
    if (!exactDef || exactDef.machineId === rawDefinitionId) {
      const latest = await findLatestInFamily(rawDefinitionId);
      if (latest) resolvedDefinitionId = latest.id;
    }
    // Also accept the machine's own name (the `id` inside the definition JSON, e.g.
    // "loan"), as the API docs show. Refuse if two families share that name.
    if (!exactDef && resolvedDefinitionId === rawDefinitionId) {
      const families = await findMachineIdsByName(rawDefinitionId);
      if (families.length > 1) {
        return reply.code(409).send({ error: `Machine name '${rawDefinitionId}' is ambiguous — it matches ${families.join(', ')}. Use a definition id.` });
      }
      if (families.length === 1) {
        const latest = await findLatestInFamily(families[0]);
        if (latest) resolvedDefinitionId = latest.id;
      }
    }

    try {
      const result = await spawnActor({
        definitionId:     resolvedDefinitionId,
        initialContext:   request.body.initialContext ?? {},
        // Logical time (APV model): one past the newest deployment of the family, for
        // every spawn — deployments committed after it apply to the actor, none before
        // it does, even for an actor pinned to an older version. Independent of this
        // server's clock, which in a cluster can be ahead of or behind the sequence.
        logicalStartTick: await pinnedLogicalTime(resolvedDefinitionId),
        spawnKey,
        spawnEventTick:   Number(tick),   // the SPAWN audit event is written with the actor
      });

      await claimNew(result.id);      // cluster mode: this server owns what it creates

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
      if (err.code === 'SPAWN_KEY_EXISTS') { const r = await existingFor(spawnKey); if (r) return r; }
      request.log.error(err);
      // A database that is briefly unreachable is not the client's mistake: 503, so
      // it retries (safely, with an idempotency key).
      const transient = /connect|terminat|timeout|ECONN|SQLITE_BUSY|database is locked/i.test(err.message ?? '');
      const code = err.statusCode === 404 ? 404 : transient ? 503 : 400;
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
    // Serialise requests that share an idempotency key BEFORE any await. The
    // duplicate check below awaits the database on Postgres, so concurrent
    // duplicates could all pass it and the transition was applied several times
    // (only one event row survived the unique index). Waiters re-run the check
    // afterwards and get the idempotent reply.
    const _idemKey = request.body?.idempotencyKey ? `${request.params.id}:${request.body.idempotencyKey}` : null;
    let _idemRelease = null;
    if (_idemKey) {
      while (idempotencyInFlight.has(_idemKey)) await idempotencyInFlight.get(_idemKey);
      idempotencyInFlight.set(_idemKey, new Promise((r) => { _idemRelease = r; }));
    }
    try {
    const t0    = Date.now();
    const eng   = getEngine();
    const tick  = eng.clockTick();
    const { id } = request.params;

    const actor = await getActorIdentity(id);
    if (!actor) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    const { type: eventType, payload, idempotencyKey } = request.body;

    // ── Idempotency check ─────────────────────────────────────────────────────
    if (idempotencyKey) {
      // Check write buffer first (event processed but not yet flushed to DB)
      const inFlight = getWriteBuffer().hasPendingEvent(id, idempotencyKey);
      let inDb = false;
      if (!inFlight) {
        if (isPostgres) {
          const { queryOne } = await import('../../registry/db-postgres.js');
          inDb = !!(await queryOne(
            `SELECT e.id FROM events e WHERE e.actor_id=$1 AND e.idempotency_key=$2`,
            [id, idempotencyKey]
          ));
        } else {
          inDb = !!getDb().prepare(
            `SELECT e.id FROM events e WHERE e.actor_id = ? AND e.idempotency_key = ?`
          ).get(id, idempotencyKey);
        }
      }

      if (inFlight || inDb) {
        const snap = inFlight ? await getActorState(id) : null;
        const current = snap ?? await findActorById(id);
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

    const event    = { ...(payload ?? {}), type: eventType };  // payload must not override the event type
    const _pri     = request.headers['x-priority'];
    const priority = _pri === 'urgent' ? 'urgent' : _pri === 'high' ? 'high' : 'normal';

    try {
      const encPayload = payload
        ? encrypt(Buffer.from(JSON.stringify(payload)))
        : null;
      const tickNum = Number(tick);

      const result = await sendEvent(id, event, tickNum, {
        priority,
        mergePayload: payload ?? null,
        eventData: {
          actor_id:        id,
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
      if (err.code === 'ACTOR_NEEDS_RESCUE' || err.code === 'ACTOR_TERMINATED' || err.code === 'ACTOR_ARCHIVED') code = 409;
      return reply.code(code).send({
        error:  err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
    } finally {
      if (_idemKey) { idempotencyInFlight.delete(_idemKey); _idemRelease(); }
    }
  });

  // ── POST /v1/actors/:id/events/batch — send up to 100 events in one call ─
  // Calls sendEvent() in a loop so each event still gets its own migration
  // check and fingerprint update. The worker pool's event-coalescing kicks in
  // automatically for consecutive events on the same actor.
  fastify.post('/v1/actors/:id/events/batch', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['events'],
        properties: {
          events: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: {
              type: 'object',
              required: ['type'],
              properties: {
                type:           { type: 'string', minLength: 1 },
                payload:        { type: 'object' },
                idempotencyKey: { type: 'string', maxLength: 128, pattern: '^[a-zA-Z0-9_\\-:.]+$' },
              },
            },
          },
          priority: { type: 'string', enum: ['urgent', 'high', 'normal', 'low'] },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const actor = await getActorIdentity(id);
    if (!actor) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    const eng      = getEngine();
    const _bpri    = request.body.priority ?? request.headers['x-priority'];
    const priority = _bpri === 'urgent' ? 'urgent' : _bpri === 'high' ? 'high' : _bpri === 'low' ? 'low' : 'normal';
    const results  = [];

    for (const evBody of request.body.events) {
      const { type: eventType, payload, idempotencyKey } = evBody;

      // Idempotency check per event (same in-flight guard as the single-event route)
      const _bKey = idempotencyKey ? `${id}:${idempotencyKey}` : null;
      let _bRelease = null;
      if (_bKey) {
        while (idempotencyInFlight.has(_bKey)) await idempotencyInFlight.get(_bKey);
        idempotencyInFlight.set(_bKey, new Promise((r) => { _bRelease = r; }));
      }
      try {
      if (idempotencyKey) {
        const inFlight = getWriteBuffer().hasPendingEvent(id, idempotencyKey);
        let inDb = false;
        if (!inFlight) {
          if (isPostgres) {
            const { queryOne } = await import('../../registry/db-postgres.js');
            inDb = !!(await queryOne(
              `SELECT e.id FROM events e WHERE e.actor_id=$1 AND e.idempotency_key=$2`,
              [id, idempotencyKey]
            ));
          } else {
            inDb = !!getDb().prepare(
              `SELECT e.id FROM events e WHERE e.actor_id = ? AND e.idempotency_key = ?`
            ).get(id, idempotencyKey);
          }
        }
        if (inFlight || inDb) {
          results.push({ skipped: true, idempotencyKey });
          continue;
        }
      }

      const tick       = eng.clockTick();
      const tickNum    = Number(tick);
      const encPayload = payload ? encrypt(Buffer.from(JSON.stringify(payload))) : null;
      const event      = { ...(payload ?? {}), type: eventType };  // payload must not override the event type

      try {
        const result = await sendEvent(id, event, tickNum, {
          priority,
          mergePayload: payload ?? null,
          eventData: {
            actor_id:        id,
            event_type:      event.type,
            event_payload:   encPayload,
            tick:            tickNum,
            processed_at:    Date.now(),
            idempotency_key: idempotencyKey ?? null,
          },
        });
        notifyStateChange(id, result.stateValue, result.context);
        results.push({
          stateValue: result.stateValue,
          done:       result.done,
          migratedTo: result.migratedTo ?? null,
        });
        if (result.done) break;
      } catch (err) {
        results.push({ error: err.message, code: err.code ?? null });
        if (err.code === 'ACTOR_NEEDS_RESCUE' || err.code === 'ACTOR_TERMINATED' || err.code === 'ACTOR_ARCHIVED') break;
      }
      } finally {
        if (_bKey) { idempotencyInFlight.delete(_bKey); _bRelease(); }
      }
    }

    return reply.send({ actorId: id, results });
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
    const actor = await getActorIdentity(id);
    if (!actor) {
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

    const actor = await getActorIdentity(id);
    if (!actor) {
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
    const actor = await getActorIdentity(id);
    if (!actor) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    const limit = Math.min(request.query.limit ?? 50, 200);
    // `after` is the preferred cursor param; `afterId` is backward-compat alias
    const after = request.query.after ?? request.query.afterId ?? 0;

    // Flush write buffer first so buffered events are visible in the DB query.
    await getWriteBuffer().flush();

    // Fetch limit+1 to detect hasMore without a COUNT query
    let rows;
    if (isPostgres) {
      const { queryAll } = await import('../../registry/db-postgres.js');
      rows = await queryAll(
        `SELECT id, event_type, event_payload, tick, processed_at FROM events WHERE actor_id=$1 AND id>$2 ORDER BY id ASC LIMIT $3`,
        [id, after, limit + 1]
      );
    } else {
      rows = getDb().prepare(`
        SELECT id, event_type, event_payload, tick, processed_at
        FROM events WHERE actor_id = ? AND id > ?
        ORDER BY id ASC LIMIT ?
      `).all(id, after, limit + 1);
    }

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
    const actor = await getActorIdentity(id);
    if (!actor) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    try {
      const _pri2    = request.headers['x-priority'];
      const priority = _pri2 === 'urgent' ? 'urgent' : _pri2 === 'high' ? 'high' : 'normal';
      const cancelled = await cancelAllPendingForActor(id);
      await terminateActor(id, { priority });
      const after = await findActorById(id);
      // Response shape per docs/API.md (plus the number of cancelled scheduled events)
      return reply.code(200).send({
        actorId:    id,
        stateValue: after?.stateValue ?? null,
        status:     after?.status ?? 'terminated',
        cancelled,
      });
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
    const actors = await findNeedsRescueActors({ limit, offset, definitionId });
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
    const actor = await getActorIdentity(id);
    if (!actor) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    const { limit, offset } = request.query;
    const rows = await findDecisionsByActor(id, { limit, offset });
    let total;
    if (isPostgres) {
      const { queryOne } = await import('../../registry/db-postgres.js');
      total = Number((await queryOne(`SELECT COUNT(*) as cnt FROM migration_decisions WHERE actor_id=$1`, [id]))?.cnt ?? 0);
    } else {
      total = getDb().prepare(`SELECT COUNT(*) as cnt FROM migration_decisions WHERE actor_id = ?`).get(id)?.cnt ?? 0;
    }

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
    const actor = await getActorIdentity(id);
    if (!actor) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    if (request.body.status !== 'active') {
      return reply.code(400).send({ error: 'Only needs_rescue → active transition is supported' });
    }
    if (actor.status !== 'needs_rescue') {
      return reply.code(409).send({ error: 'Actor is not in needs_rescue status' });
    }

    await updateActorStatus(id, 'active');

    // Write system event
    const eng  = getEngine();
    const tick = Number(eng.clockTick());
    if (isPostgres) {
      const { query } = await import('../../registry/db-postgres.js');
      await query(
        `INSERT INTO events (actor_id, event_type, event_payload, tick, processed_at) VALUES ($1,'MANUALLY_RESCUED',NULL,$2,$3)`,
        [id, tick, Date.now()]
      );
    } else {
      getDb().prepare(`
        INSERT INTO events (actor_id, event_type, event_payload, tick, processed_at)
        VALUES (?, 'MANUALLY_RESCUED', NULL, ?, ?)
      `).run(id, tick, Date.now());
    }

    const updated = await findActorById(id);
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

    // Pre-resolve all unique definitionIds to avoid N repeated DB lookups.
    // Supports machine alias: if the ID is a family root (id===machineId) or
    // doesn't match an exact definition, resolve to the latest active version.
    const resolvedIdCache = new Map();
    for (const req of requests) {
      const raw = req.definitionId;
      if (!resolvedIdCache.has(raw)) {
        const exactDef = await findDefinitionById(raw);
        if (exactDef && exactDef.machineId !== raw) {
          // Explicit version ID (e.g. 'sim-loan-v2') — use as-is
          resolvedIdCache.set(raw, raw);
        } else {
          // Family root ID or not found → resolve to latest active in family
          let latest = await findLatestInFamily(raw);
          if (!latest && !exactDef) {
            // Machine name from the definition JSON (e.g. "loan"), if unambiguous
            const families = await findMachineIdsByName(raw);
            if (families.length === 1) latest = await findLatestInFamily(families[0]);
          }
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
        slice.map(async (req) => {
          const a = await spawnActor({
            definitionId:     resolvedIdCache.get(req.definitionId),
            initialContext:   req.initialContext ?? {},
            logicalStartTick: await pinnedLogicalTime(resolvedIdCache.get(req.definitionId)),
          });
          await claimNew(a.id);        // cluster mode: this server owns what it creates
          return a;
        })
      );
      for (let j = 0; j < results.length; j++) {
        const r   = results[j];
        const raw = slice[j].definitionId;
        const resolved = resolvedIdCache.get(raw);
        if (r.status === 'fulfilled') {
          const v = r.value;
          try {
            if (isPostgres) {
              const { query } = await import('../../registry/db-postgres.js');
              await query(
                `INSERT INTO events (actor_id, event_type, event_payload, tick, processed_at) VALUES ($1,'SPAWN',NULL,$2,$3)`,
                [v.id, tick, Date.now()]
              );
            } else {
              getDb().prepare(`
                INSERT INTO events (actor_id, event_type, event_payload, tick, processed_at)
                VALUES (?, 'SPAWN', NULL, ?, ?)
              `).run(v.id, tick, Date.now());
            }
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
    const [actors, counts] = await Promise.all([
      listActors({ limit, offset, status, definitionId }),
      getActorCountsByStatus(),
    ]);
    return reply.send({
      actors,
      count:  actors.length,
      total:  counts.active + counts.migrating + counts.needs_rescue,
      counts,
    });
  });
}
