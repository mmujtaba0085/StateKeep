/**
 * src/api/middleware/auth.js
 *
 * Open-source mode: no authentication required.
 * All requests run as the single default organisation.
 */

export async function authMiddleware(request) {
  request.orgId  = 'default';
  request.apiKey = { keyId: 'open', label: 'open', tier: 'enterprise', orgId: 'default' };
}

export function adminMiddleware(_request, _reply, done) {
  done();
}
