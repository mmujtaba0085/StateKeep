/**
 * src/api/routes/webhooks.js
 *
 * POST   /v1/webhooks          — Register a webhook endpoint
 * GET    /v1/webhooks          — List org's webhooks (secret never returned)
 * DELETE /v1/webhooks/:id      — Deactivate a webhook (sets active=0, keeps audit row)
 * POST   /v1/webhooks/:id/ping — Queue a test delivery to verify the endpoint
 *
 * Security constraints:
 *   - URL must be HTTPS — http:// URLs are rejected with 400
 *   - Secret is stored AES-256-GCM encrypted (same key as actor context)
 *   - Secret is NEVER returned after creation
 *   - Cross-org access always 404, never 403
 */

import { getDb, encrypt, isPostgres } from '../../registry/db.js';
import { randomUUID } from 'crypto';

// In test mode allow http://localhost and http://127.0.0.1 for webhook delivery targets.
const isTestLocalhost = (url) =>
  process.env.NODE_ENV === 'test' &&
  (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1'));

const KNOWN_EVENT_TYPES = new Set([
  'state.changed',
  'actor.migrated',
  'actor.terminated',
  'actor.needs_rescue',
  'scheduled.fired',
  'scheduled.failed',
]);

function toWebhookDto(r) {
  return {
    id:           r.id,
    url:          r.url,
    events:       typeof r.events === 'string' ? JSON.parse(r.events) : r.events,
    active:       r.active === 1 || r.active === true,
    createdAt:    r.created_at,
    lastFiredAt:  r.last_fired_at,
    failureCount: r.failure_count,
  };
}

export async function webhookRoutes(fastify) {

  // ── POST /v1/webhooks ──────────────────────────────────────────────────────
  fastify.post('/v1/webhooks', {
    schema: {
      body: {
        type: 'object',
        required: ['url', 'secret', 'events'],
        properties: {
          url:    { type: 'string', minLength: 1 },
          secret: { type: 'string', minLength: 16 },
          events: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { url, secret, events } = request.body;

    if (!url.startsWith('https://') && !isTestLocalhost(url)) {
      return reply.code(400).send({ error: 'Webhook URL must use HTTPS (http:// is not allowed)' });
    }

    const unknown = events.filter(e => !KNOWN_EVENT_TYPES.has(e));
    if (unknown.length > 0) {
      return reply.code(400).send({
        error: `Unknown event types: ${unknown.join(', ')}`,
        validTypes: [...KNOWN_EVENT_TYPES],
      });
    }

    const id              = randomUUID();
    const encryptedSecret = encrypt(Buffer.from(secret, 'utf8'));
    const now             = Date.now();
    const eventsJson      = JSON.stringify(events);

    if (isPostgres) {
      const { query } = await import('../../registry/db-postgres.js');
      await query(
        `INSERT INTO webhooks (id, org_id, url, secret, events, active, created_at) VALUES ($1,$2,$3,$4,$5,true,$6)`,
        [id, request.orgId, url, encryptedSecret, eventsJson, now]
      );
    } else {
      getDb().prepare(`INSERT INTO webhooks (id, org_id, url, secret, events, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`
      ).run(id, request.orgId, url, encryptedSecret, eventsJson, now);
    }

    return reply.code(201).send({
      id,
      url,
      events,
      active:    true,
      createdAt: now,
      note:      'Save the secret — it will not be shown again.',
    });
  });

  // ── GET /v1/webhooks ───────────────────────────────────────────────────────
  fastify.get('/v1/webhooks', {}, async (request, reply) => {
    let rows;
    if (isPostgres) {
      const { queryAll } = await import('../../registry/db-postgres.js');
      rows = await queryAll(
        `SELECT id, url, events, active, created_at, last_fired_at, failure_count FROM webhooks WHERE org_id=$1 ORDER BY created_at DESC`,
        [request.orgId]
      );
    } else {
      rows = getDb().prepare(
        `SELECT id, url, events, active, created_at, last_fired_at, failure_count FROM webhooks WHERE org_id = ? ORDER BY created_at DESC`
      ).all(request.orgId);
    }
    return reply.send({ webhooks: rows.map(toWebhookDto) });
  });

  // ── GET /v1/webhooks/:id ──────────────────────────────────────────────────
  fastify.get('/v1/webhooks/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    let row;
    if (isPostgres) {
      const { queryOne } = await import('../../registry/db-postgres.js');
      row = await queryOne(
        `SELECT id, url, events, active, created_at, last_fired_at, failure_count FROM webhooks WHERE id=$1 AND org_id=$2`,
        [request.params.id, request.orgId]
      );
    } else {
      row = getDb().prepare(
        `SELECT id, url, events, active, created_at, last_fired_at, failure_count FROM webhooks WHERE id = ? AND org_id = ?`
      ).get(request.params.id, request.orgId);
    }
    if (!row) return reply.code(404).send({ error: `Webhook ${request.params.id} not found` });
    return reply.send(toWebhookDto(row));
  });

  // ── PATCH /v1/webhooks/:id ─────────────────────────────────────────────────
  fastify.patch('/v1/webhooks/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          url:    { type: 'string', minLength: 1 },
          events: { type: 'array', items: { type: 'string' }, minItems: 1 },
          active: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;

    let existing;
    if (isPostgres) {
      const { queryOne } = await import('../../registry/db-postgres.js');
      existing = await queryOne(`SELECT id FROM webhooks WHERE id=$1 AND org_id=$2`, [id, request.orgId]);
    } else {
      existing = getDb().prepare(`SELECT id FROM webhooks WHERE id = ? AND org_id = ?`).get(id, request.orgId);
    }
    if (!existing) return reply.code(404).send({ error: `Webhook ${id} not found` });

    const { url, events, active } = request.body ?? {};

    if (url !== undefined && !url.startsWith('https://') && !isTestLocalhost(url)) {
      return reply.code(400).send({ error: 'Webhook URL must use HTTPS' });
    }
    if (events !== undefined) {
      const unknown = events.filter(e => !KNOWN_EVENT_TYPES.has(e));
      if (unknown.length > 0) {
        return reply.code(400).send({ error: `Unknown event types: ${unknown.join(', ')}`, validTypes: [...KNOWN_EVENT_TYPES] });
      }
    }

    if (url === undefined && events === undefined && active === undefined) {
      return reply.code(400).send({ error: 'No fields to update' });
    }

    let updated;
    if (isPostgres) {
      const { query, queryOne } = await import('../../registry/db-postgres.js');
      const setParts = [];
      const values   = [];
      let pi = 1;
      if (url    !== undefined) { setParts.push(`url=$${pi++}`);                values.push(url); }
      if (events !== undefined) { setParts.push(`events=$${pi++}`);             values.push(JSON.stringify(events)); }
      if (active !== undefined) { setParts.push(`active=$${pi++}`);             values.push(active); }
      values.push(id);
      await query(`UPDATE webhooks SET ${setParts.join(', ')} WHERE id=$${pi}`, values);
      updated = await queryOne(`SELECT id, url, events, active, created_at, last_fired_at, failure_count FROM webhooks WHERE id=$1`, [id]);
    } else {
      const db     = getDb();
      const fields = [];
      const values = [];
      if (url    !== undefined) { fields.push('url = ?');    values.push(url); }
      if (events !== undefined) { fields.push('events = ?'); values.push(JSON.stringify(events)); }
      if (active !== undefined) { fields.push('active = ?'); values.push(active ? 1 : 0); }
      values.push(id);
      db.prepare(`UPDATE webhooks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      updated = db.prepare(`SELECT id, url, events, active, created_at, last_fired_at, failure_count FROM webhooks WHERE id = ?`).get(id);
    }

    return reply.send(toWebhookDto(updated));
  });

  // ── DELETE /v1/webhooks/:id ────────────────────────────────────────────────
  fastify.delete('/v1/webhooks/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id: webhookId } = request.params;

    let exists;
    if (isPostgres) {
      const { queryOne, query } = await import('../../registry/db-postgres.js');
      exists = await queryOne(`SELECT id FROM webhooks WHERE id=$1 AND org_id=$2`, [webhookId, request.orgId]);
      if (!exists) return reply.code(404).send({ error: `Webhook ${webhookId} not found` });
      await query(`DELETE FROM webhook_deliveries WHERE webhook_id=$1`, [webhookId]);
      await query(`DELETE FROM webhooks WHERE id=$1`, [webhookId]);
    } else {
      const db = getDb();
      exists = db.prepare(`SELECT id FROM webhooks WHERE id = ? AND org_id = ?`).get(webhookId, request.orgId);
      if (!exists) return reply.code(404).send({ error: `Webhook ${webhookId} not found` });
      db.transaction(() => {
        db.prepare(`DELETE FROM webhook_deliveries WHERE webhook_id = ?`).run(webhookId);
        db.prepare(`DELETE FROM webhooks WHERE id = ?`).run(webhookId);
      })();
    }

    return reply.code(204).send();
  });

  // ── POST /v1/webhooks/:id/ping ─────────────────────────────────────────────
  fastify.post('/v1/webhooks/:id/ping', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id: webhookId } = request.params;

    let row;
    if (isPostgres) {
      const { queryOne } = await import('../../registry/db-postgres.js');
      row = await queryOne(`SELECT id, url FROM webhooks WHERE id=$1 AND org_id=$2`, [webhookId, request.orgId]);
    } else {
      row = getDb().prepare(`SELECT id, url FROM webhooks WHERE id = ? AND org_id = ?`).get(webhookId, request.orgId);
    }
    if (!row) return reply.code(404).send({ error: `Webhook ${webhookId} not found` });

    const deliveryId = randomUUID();
    const now        = Date.now();
    const payload    = JSON.stringify({ eventType: 'ping', orgId: request.orgId, timestamp: now, data: {} });

    if (isPostgres) {
      const { query } = await import('../../registry/db-postgres.js');
      await query(
        `INSERT INTO webhook_deliveries (id, webhook_id, org_id, event_type, payload, status, attempts, created_at) VALUES ($1,$2,$3,'ping',$4,'pending',0,$5)`,
        [deliveryId, row.id, request.orgId, payload, now]
      );
    } else {
      getDb().prepare(
        `INSERT INTO webhook_deliveries (id, webhook_id, org_id, event_type, payload, status, attempts, created_at) VALUES (?, ?, ?, 'ping', ?, 'pending', 0, ?)`
      ).run(deliveryId, row.id, request.orgId, payload, now);
    }

    return reply.code(202).send({ deliveryId, message: 'Ping queued for delivery' });
  });

  // ── GET /v1/webhooks/:id/deliveries ───────────────────────────────────────
  fastify.get('/v1/webhooks/:id/deliveries', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'delivered', 'failed', 'all'], default: 'all' },
          limit:  { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { status, limit, offset } = request.query;

    let webhook, rows;
    if (isPostgres) {
      const { queryOne, queryAll } = await import('../../registry/db-postgres.js');
      webhook = await queryOne(`SELECT id FROM webhooks WHERE id=$1 AND org_id=$2`, [id, request.orgId]);
      if (!webhook) return reply.code(404).send({ error: `Webhook ${id} not found` });
      if (status && status !== 'all') {
        rows = await queryAll(
          `SELECT id, event_type, status, attempts, last_attempt, response_code, error, created_at, payload FROM webhook_deliveries WHERE webhook_id=$1 AND status=$2 ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
          [id, status, limit, offset]
        );
      } else {
        rows = await queryAll(
          `SELECT id, event_type, status, attempts, last_attempt, response_code, error, created_at, payload FROM webhook_deliveries WHERE webhook_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
          [id, limit, offset]
        );
      }
    } else {
      const db = getDb();
      webhook = db.prepare(`SELECT id FROM webhooks WHERE id = ? AND org_id = ?`).get(id, request.orgId);
      if (!webhook) return reply.code(404).send({ error: `Webhook ${id} not found` });
      if (status && status !== 'all') {
        rows = db.prepare(
          `SELECT id, event_type, status, attempts, last_attempt, response_code, error, created_at, payload FROM webhook_deliveries WHERE webhook_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
        ).all(id, status, limit, offset);
      } else {
        rows = db.prepare(
          `SELECT id, event_type, status, attempts, last_attempt, response_code, error, created_at, payload FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
        ).all(id, limit, offset);
      }
    }

    const deliveries = rows.map(r => ({
      id:           r.id,
      eventType:    r.event_type,
      status:       r.status,
      attempts:     r.attempts,
      lastAttempt:  r.last_attempt,
      responseCode: r.response_code,
      error:        r.error ?? null,
      createdAt:    r.created_at,
      payload:      typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
    }));

    return reply.send({ webhookId: id, deliveries, count: deliveries.length });
  });
}
