/**
 * src/api/routes/orgs.js
 *
 * Admin-only org management endpoints.
 *
 * POST   /v1/orgs                        — Create organisation
 * GET    /v1/orgs                        — List all organisations
 * DELETE /v1/orgs/:orgId                 — Delete org (refuses if active actors exist)
 * POST   /v1/orgs/:orgId/keys            — Provision API key for an org
 * GET    /v1/orgs/:orgId/keys            — List API keys for an org
 * DELETE /v1/orgs/:orgId/keys/:keyId     — Revoke a specific key for an org
 * GET    /v1/orgs/:orgId/usage           — Usage stats (admin or own org)
 */

import { adminMiddleware } from '../middleware/auth.js';
import { createOrg, findOrgById, listOrgs, deleteOrg } from '../../registry/orgRepo.js';
import { createApiKey, listApiKeysByOrg, revokeApiKey } from '../../registry/apiKeyRepo.js';
import { getActorCountsByStatus, countActiveActors } from '../../registry/actorRepo.js';
import { getDb } from '../../registry/db.js';

export async function orgsRoutes(fastify) {

  // ── POST /v1/orgs ──────────────────────────────────────────────────────────
  fastify.post('/v1/orgs', {
    preHandler: adminMiddleware,
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
    },
  }, async (request, reply) => {
    const org = createOrg({ name: request.body.name });
    return reply.code(201).send(org);
  });

  // ── GET /v1/orgs ───────────────────────────────────────────────────────────
  fastify.get('/v1/orgs', {
    preHandler: adminMiddleware,
  }, async (_request, reply) => {
    return reply.send({ orgs: listOrgs() });
  });

  // ── DELETE /v1/orgs/:orgId ─────────────────────────────────────────────────
  fastify.delete('/v1/orgs/:orgId', {
    preHandler: adminMiddleware,
    schema: {
      params: {
        type: 'object',
        properties: { orgId: { type: 'string' } },
        required: ['orgId'],
      },
    },
  }, async (request, reply) => {
    const { orgId } = request.params;
    const org = findOrgById(orgId);
    if (!org) return reply.code(404).send({ error: `Org ${orgId} not found` });

    const activeCount = countActiveActors(orgId);
    if (activeCount > 0) {
      return reply.code(409).send({
        error:        `Cannot delete org with active actors`,
        activeActors: activeCount,
      });
    }

    // Delete all keys for the org, then delete the org record.
    // Actor/definition/event history is retained for audit.
    const db = getDb();
    db.prepare(`DELETE FROM api_keys WHERE org_id = ?`).run(orgId);
    deleteOrg(orgId);

    return reply.code(204).send();
  });

  // ── POST /v1/orgs/:orgId/keys ──────────────────────────────────────────────
  fastify.post('/v1/orgs/:orgId/keys', {
    preHandler: adminMiddleware,
    schema: {
      params: {
        type: 'object',
        properties: { orgId: { type: 'string' } },
        required: ['orgId'],
      },
      body: {
        type: 'object',
        required: ['label'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 80 },
          tier:  { type: 'string', enum: ['free', 'pro', 'enterprise'], default: 'free' },
        },
      },
    },
  }, async (request, reply) => {
    const { orgId } = request.params;
    const org = findOrgById(orgId);
    if (!org) return reply.code(404).send({ error: `Org ${orgId} not found` });

    const { label, tier = 'free' } = request.body;
    const result = await createApiKey({ label, tier, orgId });
    return reply.code(201).send({
      keyId:  result.keyId,
      rawKey: result.rawKey,
      label:  result.label,
      tier:   result.tier,
      orgId:  result.orgId,
      note:   'Save this key — it will not be shown again.',
    });
  });

  // ── GET /v1/orgs/:orgId/keys ───────────────────────────────────────────────
  fastify.get('/v1/orgs/:orgId/keys', {
    preHandler: adminMiddleware,
    schema: {
      params: {
        type: 'object',
        properties: { orgId: { type: 'string' } },
        required: ['orgId'],
      },
    },
  }, async (request, reply) => {
    const { orgId } = request.params;
    const org = findOrgById(orgId);
    if (!org) return reply.code(404).send({ error: `Org ${orgId} not found` });

    return reply.send({ keys: listApiKeysByOrg(orgId) });
  });

  // ── DELETE /v1/orgs/:orgId/keys/:keyId ────────────────────────────────────
  fastify.delete('/v1/orgs/:orgId/keys/:keyId', {
    preHandler: adminMiddleware,
    schema: {
      params: {
        type: 'object',
        properties: {
          orgId: { type: 'string' },
          keyId: { type: 'string' },
        },
        required: ['orgId', 'keyId'],
      },
    },
  }, async (request, reply) => {
    const { orgId, keyId } = request.params;

    // Verify the key belongs to the specified org
    const keys = listApiKeysByOrg(orgId);
    const key  = keys.find(k => k.key_id === keyId);
    if (!key) {
      return reply.code(404).send({ error: `Key ${keyId} not found in org ${orgId}` });
    }

    revokeApiKey(keyId);
    return reply.code(204).send();
  });

  // ── GET /v1/orgs/:orgId/usage ─────────────────────────────────────────────
  fastify.get('/v1/orgs/:orgId/usage', {
    schema: {
      params: {
        type: 'object',
        properties: { orgId: { type: 'string' } },
        required: ['orgId'],
      },
    },
  }, async (request, reply) => {
    const { orgId } = request.params;

    // Admin can access any org; a regular key can only access their own org
    const isAdmin   = request.headers['x-admin-key'] === process.env.STATEKEEP_ADMIN_KEY
                      && process.env.STATEKEEP_ADMIN_KEY;
    const isOwnOrg  = request.orgId === orgId;
    if (!isAdmin && !isOwnOrg) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    const org = findOrgById(orgId);
    if (!org) return reply.code(404).send({ error: `Org ${orgId} not found` });

    const db  = getDb();
    const now = new Date();

    // Start of current calendar month (UTC)
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

    const actors      = getActorCountsByStatus(orgId);
    const definitions = db.prepare(`
      SELECT COUNT(*) as cnt FROM definitions WHERE org_id = ?
    `).get(orgId)?.cnt ?? 0;

    const eventCounts = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN event_type = 'SPAWN'                 THEN 1 ELSE 0 END) as spawns,
        SUM(CASE WHEN event_type = 'SCHEDULED_EVENT_FIRED' THEN 1 ELSE 0 END) as scheduled
      FROM events
      WHERE org_id = ? AND processed_at >= ?
    `).get(orgId, monthStart);

    const schedCounts = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'fired'   AND fired_at >= ? THEN 1 ELSE 0 END) as fired,
        SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) as failed
      FROM scheduled_events
      WHERE org_id = ?
    `).get(monthStart, orgId);

    return reply.send({
      orgId,
      period: {
        from: new Date(monthStart).toISOString(),
        to:   now.toISOString(),
      },
      actors: {
        active:       actors.active,
        terminated:   actors.terminated,
        archived:     actors.archived,
        needs_rescue: actors.needs_rescue,
      },
      events: {
        total:     eventCounts?.total     ?? 0,
        spawns:    eventCounts?.spawns    ?? 0,
        scheduled: eventCounts?.scheduled ?? 0,
      },
      definitions,
      scheduledEvents: {
        pending: schedCounts?.pending ?? 0,
        fired:   schedCounts?.fired   ?? 0,
        failed:  schedCounts?.failed  ?? 0,
      },
    });
  });
}
