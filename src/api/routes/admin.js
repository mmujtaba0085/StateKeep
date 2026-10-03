/**
 * src/api/routes/admin.js
 *
 * POST /v1/admin/workers/:type/restart — force-restart a worker pool
 *   type: 'actor'   — terminates and re-spawns all actor worker threads
 *   type: 'migrate' — migrate-worker is systemd-managed; returns guidance
 */

import { pathToFileURL } from 'url';
import { resolve }       from 'path';
import { getWorkerPool } from '../../runtime/workerPool.js';
import { setGlobalRegistry, loadRegistry } from '../../runtime/implementationRegistry.js';
import { metaCount } from '../../runtime/routingRegistry.js';
import { getDb, isPostgres } from '../../registry/db.js';

export async function adminRoutes(fastify) {

  // GET /v1/admin/registry?family=<machineId> — routing registry of one workflow family:
  // change-points stored, how many were collected (below the collection frontier), and how
  // many this server's registry currently holds.
  fastify.get('/v1/admin/registry', {
    schema: { querystring: { type: 'object', required: ['family'], properties: { family: { type: 'string' } } } },
  }, async (request, reply) => {
    const fam = request.query.family;
    const sql = `SELECT COUNT(*) AS n, SUM(CASE WHEN cp.collected_at IS NULL THEN 0 ELSE 1 END) AS c
      FROM (SELECT child_def_id, collected_at FROM changepoints UNION ALL SELECT child_def_id, collected_at FROM par_changepoints) cp
      JOIN definitions d ON d.id = cp.child_def_id WHERE d.machine_id = $1`;
    let row;
    if (isPostgres) {
      const { queryOne } = await import('../../registry/db-postgres.js');
      row = await queryOne(sql, [fam]);
    } else {
      row = getDb().prepare(sql.replace('$1', '?')).get(fam);
    }
    return reply.send({ family: fam, changepoints: Number(row?.n ?? 0), collected: Number(row?.c ?? 0), live: metaCount(fam) });
  });

  fastify.post('/v1/admin/workers/:type/restart', {
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

  // POST /v1/admin/setup/reload — hot-swap the implementation registry without restarting.
  // Cache-bust: append ?t=timestamp to the file URL so Node.js re-executes the module.
  // On failure: old registry stays active — safe rollback, returns 500.
  fastify.post('/v1/admin/setup/reload', {
    schema: { hide: true },
  }, async (request, reply) => {
    const registryPath = process.env.STATEKEEP_REGISTRY_PATH;
    if (!registryPath) {
      return reply.code(400).send({ error: 'STATEKEEP_REGISTRY_PATH is not set' });
    }
    try {
      const fileUrl = pathToFileURL(resolve(registryPath)).href + '?t=' + Date.now();
      const mod = await import(fileUrl);
      setGlobalRegistry(loadRegistry({
        guards:   mod.guards   ?? mod.default?.guards   ?? {},
        actions:  mod.actions  ?? mod.default?.actions  ?? {},
        services: mod.services ?? mod.default?.services ?? {},
      }));
      request.log.info(`[admin] Implementation registry reloaded from ${registryPath}`);
      return reply.send({ reloaded: true });
    } catch (err) {
      request.log.error({ err }, '[admin] Registry reload failed — old registry still active');
      return reply.code(500).send({ error: err.message });
    }
  });
}
