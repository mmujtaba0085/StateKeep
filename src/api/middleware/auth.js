/**
 * src/api/middleware/auth.js
 *
 * authMiddleware  — validates X-API-Key; sets req.apiKey + req.orgId.
 * adminMiddleware — validates X-Admin-Key against STATEKEEP_ADMIN_KEY.
 *
 * Dashboard static files (/dashboard/...) are always served without
 * server-side auth — security is enforced client-side via sessionStorage
 * and the /v1/auth/verify endpoint.
 */

import { validateApiKey } from '../../registry/apiKeyRepo.js';
import { ADMIN_KEY } from '../adminKey.js';

const PUBLIC_PATHS = new Set([
  '/v1/health',
  '/v1/health/workers',
  '/v1/health/queues',
  '/v1/metrics',
  '/v1/auth/verify',
  '/v1/auth/login',
  '/api-explorer',
  '/openapi.json',
  '/docs',
]);

export async function authMiddleware(request, reply) {
  const path       = request.routeOptions?.url ?? request.url.split('?')[0];
  const actualPath = request.url.split('?')[0];

  if (PUBLIC_PATHS.has(path)) return;

  // Dashboard static files are always public — auth is client-side via sessionStorage
  if (actualPath.startsWith('/dashboard/')) return;

  const rawKey = request.headers['x-api-key'];

  // In test mode: accept the sentinel key without DB lookup so integration tests
  // can run without seeding a key into the server's DB. Real keys and wrong keys
  // still go through normal validation (preserves 401/403 auth tests).
  if (process.env.NODE_ENV === 'test' && rawKey === '__test_key_do_not_use_in_production__') {
    request.apiKey = { keyId: 'test', label: 'test', tier: 'enterprise', orgId: 'default' };
    request.orgId  = 'default';
    return;
  }

  if (!rawKey) {
    return reply.code(401).send({ error: 'Missing X-API-Key header' });
  }

  const keyInfo = await validateApiKey(rawKey);
  if (!keyInfo) {
    return reply.code(403).send({ error: 'Invalid API key' });
  }

  request.apiKey = keyInfo;                  // { keyId, label, tier, orgId }
  request.orgId  = keyInfo.orgId;            // always set explicitly from key lookup
}

/**
 * preHandler for admin-only endpoints.
 * Checks X-Admin-Key header against STATEKEEP_ADMIN_KEY.
 * In test mode accepts the value of STATEKEEP_ADMIN_KEY (set to 'test-admin-key').
 */
export function adminMiddleware(request, reply, done) {
  const key = request.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) {
    return reply.code(403).send({ error: 'Invalid or missing X-Admin-Key header' });
  }
  done();
}
