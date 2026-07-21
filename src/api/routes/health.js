/**
 * src/api/routes/health.js
 * GET /v1/health         — no auth required.
 * GET /v1/health/workers — no auth required; reports worker heartbeat status.
 */

import { getDb, isPostgres } from '../../registry/db.js';
import { getEngine } from '../../ffi/engine.js';
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
      if (isPostgres) {
        const { query } = await import('../../registry/db-postgres.js');
        await query('SELECT 1', []);
      } else {
        getDb().prepare('SELECT 1').get();
      }
    } catch (e) {
      dbStatus = 'error';
    }

    const eng = getEngine();

    return reply.send({
      status:    dbStatus === 'ok' ? 'ok' : 'degraded',
      engine:    eng.mode,
      db:        dbStatus,
      uptime:    Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  fastify.get('/v1/health/workers', async (_req, reply) => {
    const now = Date.now();
    let rows;
    if (isPostgres) {
      const { queryAll } = await import('../../registry/db-postgres.js');
      rows = await queryAll(`
        SELECT worker_type, MAX(last_beat) AS last_beat, pid, started_at, worker_id
        FROM worker_heartbeats
        GROUP BY worker_type
        ORDER BY worker_type
      `, []);
    } else {
      rows = getDb().prepare(`
        SELECT worker_type,
               MAX(last_beat) AS last_beat,
               pid,
               started_at,
               worker_id
        FROM worker_heartbeats
        GROUP BY worker_type
        ORDER BY worker_type
      `).all();
    }

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

  // ── DELETE /v1/health/workers/:workerId ───────────────────────────────────
  fastify.delete('/v1/health/workers/:workerId', {
    schema: {
      params: {
        type: 'object',
        properties: { workerId: { type: 'string' } },
        required: ['workerId'],
      },
    },
  }, async (request, reply) => {
    const { workerId } = request.params;
    let deleted;
    if (isPostgres) {
      const { query } = await import('../../registry/db-postgres.js');
      const r = await query(`DELETE FROM worker_heartbeats WHERE worker_id=$1`, [workerId]);
      deleted = r.rowCount;
    } else {
      deleted = getDb().prepare(`DELETE FROM worker_heartbeats WHERE worker_id = ?`).run(workerId).changes;
    }
    return reply.code(deleted ? 204 : 404).send();
  });
}
