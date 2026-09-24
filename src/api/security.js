/**
 * src/api/security.js
 *
 * Secure-by-default access control for the HTTP API.
 *
 *   STATEKEEP_API_KEY set    → every /v1 route (except the public health check)
 *                              requires `X-API-Key: <key>`. Server may bind publicly.
 *   STATEKEEP_API_KEY unset  → "open mode": no key required, but the server only
 *                              listens on 127.0.0.1 unless the operator explicitly
 *                              opts in with STATEKEEP_ALLOW_UNAUTHENTICATED=true.
 *
 *   Admin / internal routes (/v1/admin/*, /v1/internal/*, worker deregistration)
 *   require `X-Admin-Key: <STATEKEEP_ADMIN_KEY>`. When no admin key is configured
 *   they are only reachable from loopback (the co-located migrate-worker).
 *
 * All key comparisons are constant-time.
 */

import { timingSafeEqual, createHash } from 'crypto';

const PUBLIC_ROUTES = new Set(['GET /v1/health']);
const LOOPBACK      = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isAdminRoute(method, url) {
  return url.startsWith('/v1/admin/') || url.startsWith('/v1/internal/')
      || (method === 'DELETE' && url.startsWith('/v1/health/workers/'));
}

/** Constant-time string compare (hash first so lengths never leak). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function securityConfig(env = process.env) {
  const apiKey   = env.STATEKEEP_API_KEY   || '';
  const adminKey = env.STATEKEEP_ADMIN_KEY || '';
  const allowOpen = env.STATEKEEP_ALLOW_UNAUTHENTICATED === 'true';
  const host = env.HOST || (apiKey || allowOpen ? '0.0.0.0' : '127.0.0.1');
  return { apiKey, adminKey, allowOpen, host };
}

/**
 * Refuse configurations that would expose an unauthenticated API to the network,
 * or store customer data unencrypted in production. Returns an error string or null.
 */
export function checkStartupSecurity(env = process.env) {
  const { apiKey, allowOpen, host } = securityConfig(env);
  if (!apiKey && !allowOpen && !LOOPBACK.has(host) && host !== 'localhost') {
    return `HOST=${host} would expose the API to the network without authentication. ` +
           `Set STATEKEEP_API_KEY, or set STATEKEEP_ALLOW_UNAUTHENTICATED=true if this is intentional ` +
           `(e.g. behind an authenticating reverse proxy).`;
  }
  const enc = env.STATEKEEP_ENCRYPTION_KEY;
  if (enc && !/^[0-9a-fA-F]{64}$/.test(enc)) {
    return 'STATEKEEP_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).';
  }
  if (!enc && env.NODE_ENV === 'production') {
    return 'STATEKEEP_ENCRYPTION_KEY is required in production — without it actor context is stored in plaintext.';
  }
  return null;
}

export function registerSecurity(fastify, env = process.env) {
  const { apiKey, adminKey } = securityConfig(env);

  fastify.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/v1/')) return;               // dashboard static files, docs, openapi
    if (PUBLIC_ROUTES.has(`${req.method} ${url}`)) return;

    if (isAdminRoute(req.method, url)) {
      if (adminKey) {
        if (!safeEqual(req.headers['x-admin-key'], adminKey)) {
          return reply.code(403).send({ error: 'Invalid or missing X-Admin-Key header' });
        }
      } else if (!LOOPBACK.has(req.socket.remoteAddress) || req.headers['x-forwarded-for']) {
        // x-forwarded-for: the request came through a reverse proxy on this host, so the
        // loopback address belongs to the proxy, not the real (possibly remote) caller.
        return reply.code(403).send({ error: 'Admin routes are loopback-only when STATEKEEP_ADMIN_KEY is not set' });
      }
      return;
    }

    if (!apiKey) return;                               // open mode (loopback-bound by default)
    // Browsers cannot set headers on WebSocket upgrades — accept ?api_key= there only.
    const isWs = req.headers.upgrade?.toLowerCase() === 'websocket';
    const presented = req.headers['x-api-key'] ?? (isWs ? req.query?.api_key : undefined);
    if (!presented) return reply.code(401).send({ error: 'Missing X-API-Key header' });
    if (!safeEqual(String(presented), apiKey)) return reply.code(403).send({ error: 'Invalid API key' });
  });
}
