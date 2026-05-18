/**
 * src/api/routes/admin.js
 *
 * POST /v1/admin/workers/:type/restart — force-restart a worker pool
 *   type: 'actor'   — terminates and re-spawns all actor worker threads
 *   type: 'migrate' — migrate-worker is systemd-managed; returns guidance
 */

import { getWorkerPool } from '../../runtime/workerPool.js';
import { adminMiddleware } from '../middleware/auth.js';

export async function adminRoutes(fastify) {

  fastify.post('/v1/admin/workers/:type/restart', {
    preHandler: adminMiddleware,
    schema: {
      params: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['actor', 'migrate'] },
        },
        required: ['type'],
      },
    },
  }, async (request, reply) => {
    const { type } = request.params;

    if (type === 'actor') {
      try {
        const pool = getWorkerPool();
        pool.restartAll();
        return reply.send({ restarted: true, type, workers: pool.workerCount });
      } catch (err) {
        request.log.error(`[admin] actor worker restart failed: ${err.message}`);
        return reply.code(500).send({ error: 'Actor worker restart failed', detail: err.message });
      }
    }

    if (type === 'migrate') {
      return reply.send({
        restarted: false,
        type,
        note: 'migrate-worker is a separate process managed by systemd. Restart with: systemctl restart statekeep-migrate-worker',
      });
    }
  });
}
