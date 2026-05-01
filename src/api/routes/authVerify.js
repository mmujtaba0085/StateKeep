/**
 * src/api/routes/authVerify.js
 *
 * POST /v1/auth/verify — Validate an API key; returns org info.
 * Used by the dashboard login form; always public (no X-API-Key required).
 */

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
}
