/**
 * src/api/routes/internal.js
 *
 * Internal-only routes consumed by other StateKeep processes (migrate-worker).
 * Not exposed in the OpenAPI spec. All routes require the admin key.
 *
 * POST /v1/internal/cache/evict  — evict one actor from the hot LRU registry
 */

import { evictFromHotRegistry, sendEvent } from '../../runtime/actorManager.js';
import { notifyStateChange } from '../websocket.js';
import { getEngine } from '../../ffi/engine.js';
import { deliverEventOnce } from '../../runtime/deliverOnce.js';

export async function internalRoutes(fastify) {

  fastify.post('/v1/internal/cache/evict', {
    schema: { hide: true },
  }, async (request, reply) => {
    const { actorId } = request.body ?? {};
    if (!actorId || typeof actorId !== 'string') {
      return reply.code(400).send({ error: 'actorId (string) is required' });
    }

    evictFromHotRegistry(actorId);
    return reply.code(204).send();
  });

  // POST /v1/internal/actors/:id/dispatch — deliver an event on behalf of another
  // StateKeep process (scheduler-worker). The API server owns the in-memory actor
  // cache, so it must be the one that applies transitions: when the scheduler called
  // sendEvent() in its own process, the server kept serving (and later wrote back)
  // its stale cached state — a fired timeout could be silently undone.
  fastify.post('/v1/internal/actors/:id/dispatch', {
    schema: {
      hide: true,
      body: {
        type: 'object', required: ['event'],
        properties: { event: { type: 'object', required: ['type'] }, tick: { type: 'number' }, idempotencyKey: { type: 'string', maxLength: 200 } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { event } = request.body;
    try {
      // Stamp with THIS process's APV clock (each process has its own in-memory clock).
      const eng    = getEngine();
      const tick   = eng.available ? Number(eng.clockTick()) : Date.now();
      const isSystem = typeof event.type === 'string' && event.type.startsWith('__SK_');
      if (request.body.idempotencyKey) {
        const r = await deliverEventOnce(id, event, request.body.idempotencyKey, { mergePayload: isSystem ? null : event });
        if (r.duplicate) return reply.send({ actorId: id, duplicate: true });
        notifyStateChange(id, r.result.stateValue, r.result.context);
        return reply.send({ actorId: id, stateValue: r.result.stateValue, done: r.result.done });
      }
      const result = await sendEvent(id, event, tick, { mergePayload: isSystem ? null : event });
      notifyStateChange(id, result.stateValue, result.context);
      return reply.send({ actorId: id, stateValue: result.stateValue, done: result.done });
    } catch (err) {
      const code = err.statusCode ?? (err.code === 'ACTOR_NEEDS_RESCUE' ? 409 : err.message.includes('not found') ? 404 : 500);
      return reply.code(code).send({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
  });
}
