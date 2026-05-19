/**
 * src/api/routes/authVerify.js
 *
 * POST /v1/auth/verify — Validate an API key; returns org info.
 * POST /v1/auth/login  — Validate dashboard username/password; returns API key.
 * Both are always public (no X-API-Key required).
 */

import { timingSafeEqual } from 'node:crypto';
import { validateApiKey } from '../../registry/apiKeyRepo.js';

export async function authVerifyRoutes(fastify) {

  fastify.post('/v1/auth/verify', {
    config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    schema: {
      body: {
        type: 'object',
        required: ['apiKey'],
        properties: {
          apiKey: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const keyInfo = await validateApiKey(request.body.apiKey);
    if (!keyInfo) {
      return reply.code(401).send({ error: 'Invalid API key' });
    }
    return reply.send({
      valid:  true,
      keyId:  keyInfo.keyId,
      label:  keyInfo.label,
      tier:   keyInfo.tier,
      orgId:  keyInfo.orgId,
    });
  });

  fastify.post('/v1/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 1, maxLength: 64 },
          password: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
    },
  }, async (request, reply) => {
    const { username, password } = request.body;
    const envUser = process.env.DASHBOARD_USERNAME ?? '';
    const envPass = process.env.DASHBOARD_PASSWORD ?? '';
    const apiKey  = process.env.STATEKEEP_API_KEY  ?? '';

    if (!envUser || !envPass || !apiKey) {
      return reply.code(503).send({ error: 'Dashboard credentials not configured on server' });
    }

    // Constant-time comparison — pad to same length before comparing
    const enc = (s) => Buffer.from(s.padEnd(Math.max(username.length, envUser.length, password.length, envPass.length)));
    const userOk = timingSafeEqual(enc(username), enc(envUser));
    const passOk = timingSafeEqual(enc(password), enc(envPass));

    if (!userOk || !passOk) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    return reply.send({ apiKey, orgId: 'default' });
  });
}
