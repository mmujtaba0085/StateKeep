/**
 * src/api/routes/health.js
 * GET /v1/health         — no auth required.
 * GET /v1/health/workers — no auth required; reports worker heartbeat status.
 */

import { getDb } from '../../registry/db.js';
import { getEngine } from '../../ffi/engine.js';
import { adminMiddleware } from '../middleware/auth.js';

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
    const rows = getDb().prepare(`
      SELECT worker_id, worker_type, last_beat, started_at, pid
      FROM worker_heartbeats
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

    const allHealthy = workers.every(w => w.healthy);

    return reply.code(allHealthy ? 200 : 503).send({
      healthy:          allHealthy,
      checkedAt:        now,
      staleThresholdMs: STALE_THRESHOLD_MS,
      workers,
    });
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
