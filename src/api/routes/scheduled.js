/**
 * src/api/routes/scheduled.js
 *
 * POST   /v1/actors/:id/schedule      — Schedule a future event for an actor
 * GET    /v1/actors/:id/schedule      — List scheduled events for an actor
 * DELETE /v1/actors/:id/schedule/:sid — Cancel a pending scheduled event
 * GET    /v1/scheduled               — Admin: list all pending scheduled events
 */

import { findActorById }                                        from '../../registry/actorRepo.js';
import {
  createScheduledEvent,
  findByActor,
  cancelScheduledEvent,
  findDueEvents,
  findDeadLetter,
} from '../../registry/scheduledEventRepo.js';
import { getDb, isPostgres } from '../../registry/db.js';

export async function scheduledRoutes(fastify) {

  // ── POST /v1/actors/:id/schedule ─────────────────────────────────────────────
  fastify.post('/v1/actors/:id/schedule', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['type', 'fireAt'],
        properties: {
          type:    { type: 'string', minLength: 1 },
          payload: { type: 'object' },
          fireAt:  { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { id }             = request.params;
    const { type, payload, fireAt } = request.body;

    const actor = await findActorById(id);
    if (!actor) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }
    if (actor.status === 'terminated' || actor.status === 'archived') {
      return reply.code(409).send({ error: `Actor ${id} is ${actor.status}` });
    }

    const schedId = await createScheduledEvent({
      actorId:   id,
      eventType: type,
      payload:   payload ?? null,
      fireAt,
    });

    return reply.code(201).send({ id: schedId, actorId: id, type, fireAt, status: 'pending' });
  });

  // ── GET /v1/actors/:id/schedule ──────────────────────────────────────────────
  fastify.get('/v1/actors/:id/schedule', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'fired', 'failed', 'cancelled', 'all'],
            default: 'all',
          },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const status  = request.query.status ?? 'all';

    const actor = await findActorById(id);
    if (!actor) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    const events = await findByActor(id, status);
    return reply.send({ actorId: id, scheduledEvents: events });
  });

  // ── DELETE /v1/actors/:id/schedule/:sid ──────────────────────────────────────
  fastify.delete('/v1/actors/:id/schedule/:sid', {
    schema: {
      params: {
        type: 'object',
        required: ['id', 'sid'],
        properties: {
          id:  { type: 'string' },
          sid: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { id, sid } = request.params;

    const actor = await findActorById(id);
    if (!actor) {
      return reply.code(404).send({ error: `Actor ${id} not found` });
    }

    const sidNum  = parseInt(sid, 10);
    if (isNaN(sidNum)) {
      return reply.code(400).send({ error: 'Invalid scheduled event id' });
    }

    const changed = await cancelScheduledEvent(sidNum, id);
    if (!changed) {
      return reply.code(404).send({ error: `Scheduled event ${sid} not found or already finished` });
    }

    return reply.code(200).send({ cancelled: true });
  });

  // ── GET /v1/scheduled (admin) ─────────────────────────────────────────────────
  fastify.get('/v1/scheduled', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const limit = request.query.limit ?? 100;
    let rows;
    if (isPostgres) {
      const { queryAll } = await import('../../registry/db-postgres.js');
      rows = await queryAll(
        `SELECT * FROM scheduled_events WHERE status='pending' ORDER BY fire_at ASC LIMIT $1`,
        [limit]
      );
    } else {
      rows = getDb().prepare(`
        SELECT * FROM scheduled_events
        WHERE status = 'pending'
        ORDER BY fire_at ASC
        LIMIT ?
      `).all(limit);
    }

    const scheduled = rows.map(r => ({
      id:        r.id,
      actorId:   r.actor_id,
      eventType: r.event_type,
      fireAt:    r.fire_at,
      status:    r.status,
      createdAt: r.created_at,
    }));

    return reply.send({ count: scheduled.length, scheduled });
  });

  // ── GET /v1/scheduled/dead-letter ─────────────────────────────────────────
  fastify.get('/v1/scheduled/dead-letter', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const limit = request.query.limit ?? 100;
    const rows  = findDeadLetter(limit);
    return reply.send({ count: rows.length, deadLetter: rows });
  });
}
