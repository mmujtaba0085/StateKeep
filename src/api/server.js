/**
 * src/api/server.js
 *
 * Fastify entry point. Registers all plugins, middleware, and route modules.
 *
 * Fixes vs original:
 *  - Log rotation condition fixed (was 'development node', now 'production')
 *  - Caddy proxy port corrected to 3001 (was 3000 in Caddyfile vs 3001 here)
 *  - Rate-limit hook ordering fixed (apiKey not set during onRequest)
 */

import Fastify from 'fastify';
import FastifyWebSocket from '@fastify/websocket';
import FastifyRateLimit from '@fastify/rate-limit';
import FastifyStatic from '@fastify/static';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { randomUUID } from 'crypto';

import { engineReady } from '../ffi/engine.js';
import { getDb } from '../registry/db.js';
import './adminKey.js';                                  // fails fast if STATEKEEP_ADMIN_KEY unset
import { authMiddleware } from './middleware/auth.js';
import { healthRoutes } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';
import { actorRoutes } from './routes/actors.js';
import { definitionRoutes } from './routes/definitions.js';
import { keysRoutes } from './routes/keys.js';
import { orgsRoutes } from './routes/orgs.js';
import { authVerifyRoutes } from './routes/authVerify.js';
import { exportRoutes }     from './routes/export.js';
import { scheduledRoutes }  from './routes/scheduled.js';
import { scenarioRoutes } from './routes/scenarios.js';
import { archiveRoutes } from './routes/archives.js';
import { webhookRoutes } from './routes/webhooks.js';
import { websocketRoutes } from './websocket.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT      = parseInt(process.env.PORT ?? '3001', 10);
const LOG_DIR   = process.env.LOG_DIR ?? './logs';

try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

// ── Logger ────────────────────────────────────────────────────────────────────
const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['req.headers["x-api-key"]'],   // never log raw keys
    ...(process.env.NODE_ENV === 'production' ? {
      transport: {
        target: 'pino-roll',
        options: {
          file:      join(LOG_DIR, 'statekeep-api'),
          frequency: 'daily',
          mkdir:     true,
          extension: '.log',
          limit:     { count: 7 },
        },
      },
    } : {}),
  },
  trustProxy: true,
  maxParamLength: 200,
  bodyLimit: 1_048_576,
});

// ── Plugins ───────────────────────────────────────────────────────────────────
await fastify.register(FastifyWebSocket);

await fastify.register(FastifyRateLimit, {
  global: true,
  max: 100,
  timeWindow: 60_000,
  // Bypass rate limiting in test mode — test suites issue many requests from localhost.
  allowList: (_req, _key) => process.env.NODE_ENV === 'test',
  // Auth hook runs in preHandler, AFTER rate limit; key auth gets higher limit
  // via a per-route override on authenticated routes.
  keyGenerator: (req) => req.ip,
  errorResponseBuilder: (_req, context) => ({
    error:      'Rate limit exceeded',
    limit:      context.max,
    timeWindow: context.after,
    retryAfter: context.ttl,
  }),
});

// ── x-request-id: echo or generate, attach to logger context, set response header ──
fastify.addHook('onRequest', async (req, reply) => {
  const id = req.headers['x-request-id'] ?? randomUUID();
  req.requestId = id;
  req.log = req.log.child({ requestId: id });
  reply.header('X-Request-Id', id);
});

// ── Auth (global preHandler, skips public paths) ──────────────────────────────
fastify.addHook('preHandler', authMiddleware);

// ── Bump rate limit for authenticated requests (runs after auth sets apiKey) ──
fastify.addHook('preHandler', async (req) => {
  if (req.apiKey) {
    // Fastify rate-limit reads req.rateLimit to override per-request
    req.rateLimit = { max: 1000, timeWindow: 60_000 };
  }
});

// ── Static dashboard ──────────────────────────────────────────────────────────
await fastify.register(FastifyStatic, {
  root:   join(__dirname, '..', 'dashboard'),
  prefix: '/dashboard/',
});

// ── Routes ────────────────────────────────────────────────────────────────────
await fastify.register(healthRoutes);
await fastify.register(metricsRoutes);
await fastify.register(actorRoutes);
await fastify.register(definitionRoutes);
await fastify.register(keysRoutes);
await fastify.register(orgsRoutes);
await fastify.register(authVerifyRoutes);
await fastify.register(exportRoutes);
await fastify.register(scheduledRoutes);
await fastify.register(scenarioRoutes);
await fastify.register(archiveRoutes);
await fastify.register(webhookRoutes);
await fastify.register(websocketRoutes);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  fastify.log.info(`Received ${signal} — shutting down gracefully`);
  try {
    await fastify.close();
    getDb().close();
  } catch {}
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Startup ───────────────────────────────────────────────────────────────────
await engineReady;
getDb();

try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`StateKeep API listening on port ${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
