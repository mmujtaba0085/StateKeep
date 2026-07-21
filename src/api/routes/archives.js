/**
 * src/api/routes/archives.js
 *
 * GET  /v1/archives              — List archived actors for the requesting org
 * POST /v1/actors/:id/restore    — Restore an archived actor to active status
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { gunzipSync, gzipSync } from 'zlib';
import { join } from 'path';
import { getDb, encrypt, isPostgres } from '../../registry/db.js';
import { findActorById, createActor, updateActorStatus } from '../../registry/actorRepo.js';
import { cancelAllPendingForActor } from '../../registry/scheduledEventRepo.js';
import { evictFromHotRegistry } from '../../runtime/actorManager.js';

const ARCHIVE_DIR = join(process.env.STATEKEEP_DATA_DIR ?? '/opt/statekeep/data', 'archives');

export async function archiveRoutes(fastify) {

  // ── GET /v1/archives ───────────────────────────────────────────────────────
  fastify.get('/v1/archives', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          machineId: { type: 'string' },
          limit:     { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset:    { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { machineId, limit, offset } = request.query;
    let rows;

    if (isPostgres) {
      const { queryAll } = await import('../../registry/db-postgres.js');
      if (machineId) {
        rows = await queryAll(
          `SELECT actor_id, machine_id, archived_at, state_value, definition_id FROM actor_archives WHERE machine_id=$1 ORDER BY archived_at DESC LIMIT $2 OFFSET $3`,
          [machineId, limit, offset]
        );
      } else {
        rows = await queryAll(
          `SELECT actor_id, machine_id, archived_at, state_value, definition_id FROM actor_archives ORDER BY archived_at DESC LIMIT $1 OFFSET $2`,
          [limit, offset]
        );
      }
    } else {
      const db = getDb();
      if (machineId) {
        rows = db.prepare(`
          SELECT actor_id, machine_id, archived_at, state_value, definition_id
          FROM actor_archives
          WHERE machine_id = ?
          ORDER BY archived_at DESC
          LIMIT ? OFFSET ?
        `).all(machineId, limit, offset);
      } else {
        rows = db.prepare(`
          SELECT actor_id, machine_id, archived_at, state_value, definition_id
          FROM actor_archives
          ORDER BY archived_at DESC
          LIMIT ? OFFSET ?
        `).all(limit, offset);
      }
    }

    const archives = rows.map(r => ({
      actorId:      r.actor_id,
      machineId:    r.machine_id,
      archivedAt:   r.archived_at,
      stateValue:   r.state_value ? JSON.parse(r.state_value) : null,
      definitionId: r.definition_id,
    }));

    return reply.send({ archives, count: archives.length });
  });

  // ── POST /v1/actors/:id/restore ────────────────────────────────────────────
  fastify.post('/v1/actors/:id/restore', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params;

    let archiveRow;
    if (isPostgres) {
      const { queryOne } = await import('../../registry/db-postgres.js');
      archiveRow = await queryOne(`SELECT * FROM actor_archives WHERE actor_id=$1`, [id]);
    } else {
      archiveRow = getDb().prepare(`SELECT * FROM actor_archives WHERE actor_id = ?`).get(id);
    }

    if (!archiveRow) {
      return reply.code(404).send({ error: `No archive found for actor ${id}` });
    }

    // Read and decompress the archive file
    let archiveData;
    try {
      const compressed = readFileSync(archiveRow.file_path);
      archiveData = JSON.parse(gunzipSync(compressed).toString('utf8'));
    } catch (err) {
      return reply.code(500).send({ error: `Failed to read archive file: ${err.message}` });
    }

    // Re-insert actor as active (re-encrypts context with current key)
    const actor = await findActorById(id);
    if (actor && actor.status === 'archived') {
      // Actor row exists but is archived — restore in-place
      await updateActorStatus(id, 'active');
    } else if (!actor) {
      // Actor row was deleted — re-create from archive
      await createActor({
        id:                 archiveData.id,
        definitionId:       archiveData.definitionId,
        stateValue:         archiveData.stateValue,
        context:            archiveData.context,
        logicalStartTick:   archiveData.logicalStartTick,
        historyFingerprint: archiveData.historyFingerprint,
      });
    } else {
      return reply.code(409).send({ error: `Actor ${id} is already active (status: ${actor.status})` });
    }

    // Remove archive record
    if (isPostgres) {
      const { query } = await import('../../registry/db-postgres.js');
      await query(`DELETE FROM actor_archives WHERE actor_id=$1`, [id]);
    } else {
      getDb().prepare(`DELETE FROM actor_archives WHERE actor_id = ?`).run(id);
    }

    const restored = await findActorById(id);
    return reply.code(201).send(restored);
  });

  // ── POST /v1/admin/actors/:id/force-archive (non-production only) ──────────
  // Replicates gc-worker archive logic on demand — used by E2E tests to avoid
  // waiting 24 h for natural GC to trigger archival.
  if (process.env.NODE_ENV !== 'production') {
    fastify.post('/v1/admin/actors/:id/force-archive', {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    }, async (request, reply) => {
      const { id } = request.params;

      const actor = await findActorById(id);
      if (!actor)                    return reply.code(404).send({ error: `Actor ${id} not found` });
      if (actor.status === 'archived') return reply.code(409).send({ error: 'Actor is already archived' });

      let machineId;
      if (isPostgres) {
        const { queryOne } = await import('../../registry/db-postgres.js');
        const def = await queryOne(`SELECT machine_id FROM definitions WHERE id=$1`, [actor.definitionId]);
        machineId = def?.machine_id ?? actor.definitionId;
      } else {
        const def = getDb().prepare('SELECT machine_id FROM definitions WHERE id = ?').get(actor.definitionId);
        machineId = def?.machine_id ?? actor.definitionId;
      }

      const now = Date.now();

      mkdirSync(ARCHIVE_DIR, { recursive: true });

      const archiveData = {
        id:                 actor.id,
        definitionId:       actor.definitionId,
        stateValue:         actor.stateValue,
        context:            actor.context,
        historyFingerprint: actor.historyFingerprint,
        logicalStartTick:   actor.logicalStartTick,
        archivedAt:         now,
      };

      const filename = join(ARCHIVE_DIR, `${actor.id}.json.gz`);
      writeFileSync(filename, gzipSync(JSON.stringify(archiveData)));

      await cancelAllPendingForActor(id);
      await updateActorStatus(id, 'archived');
      evictFromHotRegistry(id);

      if (isPostgres) {
        const { query } = await import('../../registry/db-postgres.js');
        await query(
          `INSERT INTO actor_archives (actor_id, org_id, machine_id, archived_at, file_path, state_value, definition_id)
           VALUES ($1,'default',$2,$3,$4,$5,$6) ON CONFLICT (actor_id) DO UPDATE SET archived_at=EXCLUDED.archived_at, file_path=EXCLUDED.file_path, state_value=EXCLUDED.state_value`,
          [actor.id, machineId, now, filename, actor.stateValue ? JSON.stringify(actor.stateValue) : null, actor.definitionId]
        );
      } else {
        getDb().prepare(`
          INSERT OR REPLACE INTO actor_archives
            (actor_id, org_id, machine_id, archived_at, file_path, state_value, definition_id)
          VALUES (?, 'default', ?, ?, ?, ?, ?)
        `).run(
          actor.id,
          machineId,
          now,
          filename,
          actor.stateValue ? JSON.stringify(actor.stateValue) : null,
          actor.definitionId,
        );
      }

      return reply.code(200).send({ archivedAt: now, filePath: filename });
    });
  }
}
