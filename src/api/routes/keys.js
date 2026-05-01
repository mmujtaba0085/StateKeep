/**
 * src/api/routes/keys.js
 *
 * API key management — create, list, revoke.
 * All routes require enterprise-tier key (checked inline).
 *
 * POST   /v1/keys          — Create new key
 * GET    /v1/keys          — List all keys (no hashes shown)
 * DELETE /v1/keys/:keyId   — Revoke a key
 */

import { createApiKey, listApiKeysByOrg, revokeApiKey, rotateApiKey } from '../../registry/apiKeyRepo.js';

export async function keysRoutes(fastify) {

  // Require enterprise tier for key management
  function requireEnterprise(request, reply, done) {
    if (!request.apiKey) return reply.code(401).send({ error: 'Unauthorized' });
    if (request.apiKey.tier !== 'enterprise' && request.apiKey.tier !== 'pro') {
      return reply.code(403).send({ error: 'Enterprise or pro tier required for key management' });
    }
    done();
  }

  // ── POST /v1/keys ──────────────────────────────────────────────────────────
  fastify.post('/v1/keys', {
    preHandler: requireEnterprise,
    schema: {
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
    const { label, tier = 'free' } = request.body;
    const result = await createApiKey({ label, tier, orgId: request.orgId });
    // rawKey is shown exactly once here and never stored
    return reply.code(201).send({
      keyId:  result.keyId,
      rawKey: result.rawKey,
      label:  result.label,
      tier:   result.tier,
      orgId:  result.orgId,
      note:   'Save this key — it will not be shown again.',
    });
  });

  // ── GET /v1/keys ───────────────────────────────────────────────────────────
  fastify.get('/v1/keys', {
    preHandler: requireEnterprise,
  }, async (request, reply) => {
    const keys = listApiKeysByOrg(request.orgId);
    return reply.send({ keys });
  });

  // ── POST /v1/keys/:keyId/rotate ───────────────────────────────────────────
  fastify.post('/v1/keys/:keyId/rotate', {
    preHandler: requireEnterprise,
    schema: {
      params: {
        type: 'object',
        properties: { keyId: { type: 'string' } },
        required: ['keyId'],
      },
    },
  }, async (request, reply) => {
    if (request.apiKey.keyId === request.params.keyId) {
      return reply.code(400).send({ error: 'Cannot rotate your own active key' });
    }
    const result = await rotateApiKey(request.params.keyId, request.orgId);
    if (!result) {
      return reply.code(404).send({ error: `Key ${request.params.keyId} not found` });
    }
    return reply.code(200).send({
      key:       result.rawKey,
      keyId:     result.keyId,
      label:     result.label,
      rotatedAt: result.rotatedAt,
      note:      'Save this key — it will not be shown again.',
    });
  });

  // ── DELETE /v1/keys/:keyId ─────────────────────────────────────────────────
  fastify.delete('/v1/keys/:keyId', {
    preHandler: requireEnterprise,
    schema: {
      params: {
        type: 'object',
        properties: { keyId: { type: 'string' } },
        required: ['keyId'],
      },
    },
  }, async (request, reply) => {
    // Prevent self-revocation
    if (request.apiKey.keyId === request.params.keyId) {
      return reply.code(400).send({ error: 'Cannot revoke your own active key' });
    }
    revokeApiKey(request.params.keyId);
    return reply.code(204).send();
  });
}
