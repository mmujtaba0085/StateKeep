/**
 * src/api/routes/internal.js
 *
 * Internal-only routes consumed by other StateKeep processes (migrate-worker).
 * Not exposed in the OpenAPI spec. All routes require the admin key.
 *
 * POST /v1/internal/cache/evict  — evict one actor from the hot LRU registry
 */

import { evictFromHotRegistry } from '../../runtime/actorManager.js';

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
}
