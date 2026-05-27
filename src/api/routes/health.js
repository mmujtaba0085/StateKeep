/**
 * src/api/routes/health.js
 * GET /v1/health         — no auth required.
 * GET /v1/health/workers — no auth required; reports worker heartbeat status.
 */

import { getDb } from '../../registry/db.js';
import { getEngine } from '../../ffi/engine.js';
import { adminMiddleware } from '../middleware/auth.js';
import { getWorkerPool } from '../../runtime/workerPool.js';

const STALE_THRESHOLD_MS = 2 * 60 * 1000;   // 2 minutes

export async function healthRoutes(fastify) {
  fastify.get('/v1/health', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status:        { type: 'string' },
            engine:        { type: 'string' },
            db:            { type: 'string' },
            uptime:        { type: 'number' },
            timestamp:     { type: 'string' },
          },
        },
      },
    },
  }, async (_req, reply) => {
    let dbStatus = 'ok';
    try {
      getDb().prepare('SELECT 1').get();
    } catch (e) {
      dbStatus = 'error';
    }

    const eng = getEngine();

    return reply.send({
      status:    dbStatus === 'ok' ? 'ok' : 'degraded',
      engine:    eng.available ? 'real' : 'fallback',
      db:        dbStatus,
      uptime:    Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  fastify.get('/v1/health/workers', async (_req, reply) => {
    const now  = Date.now();
    // GROUP BY worker_type keeps only the most-recent heartbeat per type.
    // This prevents ghost records from crashed/restarted processes from
    // making the endpoint report unhealthy when the current worker is fine.
    const rows = getDb().prepare(`
      SELECT worker_type,
             MAX(last_beat) AS last_beat,
             pid,
             started_at,
             worker_id
      FROM worker_heartbeats
      GROUP BY worker_type
      ORDER BY worker_type
    `).all();

    const workers = rows.map(r => ({
      workerId:   r.worker_id,
      workerType: r.worker_type,
      pid:        r.pid,
      startedAt:  r.started_at,
      lastBeat:   r.last_beat,
      staleSecs:  Math.floor((now - r.last_beat) / 1000),
      healthy:    (now - r.last_beat) < STALE_THRESHOLD_MS,
    }));

    const allHealthy = workers.length > 0 && workers.every(w => w.healthy);

    return reply.code(allHealthy ? 200 : 503).send({
      healthy:          allHealthy,
      checkedAt:        now,
      staleThresholdMs: STALE_THRESHOLD_MS,
      workers,
    });
  });

  // ── GET /v1/health/queues — worker queue stats ───────────────────────────
  fastify.get('/v1/health/queues', async (_req, reply) => {
    const pool = getWorkerPool();
    return reply.send(pool.getQueueStats());
  });

  // ── DELETE /v1/health/workers/:workerId (admin) ───────────────────────────
  fastify.delete('/v1/health/workers/:workerId', {
    preHandler: adminMiddleware,
    schema: {
      params: {
        type: 'object',
        properties: { workerId: { type: 'string' } },
        required: ['workerId'],
      },
    },
  }, async (request, reply) => {
    const deleted = getDb()
      .prepare(`DELETE FROM worker_heartbeats WHERE worker_id = ?`)
      .run(request.params.workerId).changes;
    return reply.code(deleted ? 204 : 404).send();
  });
}
