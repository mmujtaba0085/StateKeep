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
import FastifySwagger from '@fastify/swagger';
import FastifySwaggerUI from '@fastify/swagger-ui';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { randomUUID } from 'crypto';

import { engineReady, getEngine } from '../ffi/engine.js';
import { getDb } from '../registry/db.js';
import { getMaxTStar } from '../registry/changepointRepo.js';
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
import { adminRoutes } from './routes/admin.js';
import { internalRoutes } from './routes/internal.js';
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

await fastify.register(FastifySwagger, {
  openapi: {
    info: {
      title:       'StateKeep API',
      description: 'Actor lifecycle management with Anchor-Point Versioning (APV) for zero-downtime statechart migrations.',
      version:     '1.0.0',
      contact:     { name: 'StateKeep', url: 'https://statekeep.io' },
      license:     { name: 'Proprietary' },
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: 'apiKey',
          in:   'header',
          name: 'x-api-key',
          description: 'API key issued via POST /v1/keys',
        },
        adminKey: {
          type: 'apiKey',
          in:   'header',
          name: 'x-admin-key',
          description: 'Admin key from STATEKEEP_ADMIN_KEY env var',
        },
      },
    },
    security: [{ apiKey: [] }],
    tags: [
      { name: 'actors',      description: 'Actor lifecycle — spawn, events, state, terminate' },
      { name: 'definitions', description: 'Machine definition deployment and migration' },
      { name: 'webhooks',    description: 'Outbound webhook subscriptions' },
      { name: 'keys',        description: 'API key management' },
      { name: 'admin',       description: 'Admin-only operations (require X-Admin-Key)' },
      { name: 'health',      description: 'Health and metrics' },
    ],
  },
});

await fastify.register(FastifySwaggerUI, {
  routePrefix: '/docs',
  uiConfig:    { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
  staticCSP:   true,
});

await fastify.register(FastifyWebSocket);

// Tier limit cache: rawApiKey → max-per-minute.
// Populated by auth middleware after first successful key validation.
// Avoids bcrypt in the hot-path rate-limit check.
const _tierCache = new Map();
export function cacheTierLimit(rawKey, tier) {
  const TIER_LIMITS = { free: 300, pro: 1000, enterprise: 5000 };
  _tierCache.set(rawKey, TIER_LIMITS[tier] ?? 1000);
}

await fastify.register(FastifyRateLimit, {
  global: true,
  timeWindow: 60_000,
  allowList: (_req, _key) => process.env.NODE_ENV === 'test',
  // Per-org bucket: each API key gets its own counter. IP fallback for unauthenticated.
  keyGenerator: (req) => req.headers['x-api-key'] ?? req.ip,
  // max is a function so tier limits take effect without a separate hook.
  // Uses cached tier from previous auth; defaults to 100 on first request.
  max: (_req, key) => _tierCache.get(key) ?? 100,
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

// ── Populate tier cache after auth resolves the key ──────────────────────────
// The rate-limit plugin's max() function reads _tierCache synchronously.
// First request from a new key gets the default (100/min); all subsequent
// requests use the tier limit once auth has populated the cache here.
fastify.addHook('preHandler', async (req) => {
  const raw = req.headers['x-api-key'];
  if (raw && req.apiKey?.tier && !_tierCache.has(raw)) {
    cacheTierLimit(raw, req.apiKey.tier);
  }
});

// ── Static dashboard ──────────────────────────────────────────────────────────
// No caching for dashboard JS/JSX — every deploy should be visible immediately.
await fastify.register(FastifyStatic, {
  root:        join(__dirname, '..', 'dashboard'),
  prefix:      '/dashboard/',
  setHeaders:  (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  },
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
await fastify.register(adminRoutes);
await fastify.register(internalRoutes);
await fastify.register(websocketRoutes);

// ── OpenAPI JSON alias (/openapi.json → /docs/json) ──────────────────────────
fastify.get('/openapi.json', { schema: { hide: true } }, async (_req, reply) => {
  return reply.send(fastify.swagger());
});

// ── API Explorer — Swagger UI with auto-auth from dashboard localStorage ──────
fastify.get('/api-explorer', { schema: { hide: true } }, async (_req, reply) => {
  const html = `<!DOCTYPE html>
<html lang="en"><head>
  <title>StateKeep API Explorer</title>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; background: #080a0f; }
    .topbar { display: none !important; }
    #swagger-ui { max-width: 1400px; margin: 0 auto; padding: 16px; }
  </style>
</head><body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
  let ui;
  ui = SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
    layout: 'BaseLayout',
    deepLinking: true,
    persistAuthorization: true,
    requestInterceptor: (req) => {
      const k = localStorage.getItem('sk_api_key');
      if (k) req.headers['x-api-key'] = k;
      return req;
    },
    onComplete: () => {
      const k = localStorage.getItem('sk_api_key');
      if (k) ui.preauthorizeApiKey('apiKey', k);
    }
  });
</script>
</body></html>`;
  return reply.type('text/html').send(html);
});

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

// Seed APV clock from DB so new deployments get t_star values strictly greater
// than all historical changepoints.  Without this, a server restart resets the
// in-memory counter to 1, causing new definitions to get deployedAt=1 which
// pre-dates all existing actors and breaks the engine's ordering logic.
try {
  const maxTStar = getMaxTStar();
  if (maxTStar > 0) {
    const eng = getEngine();
    if (!eng.available) {
      eng.seedTick(maxTStar);
      console.log(`[server] Fallback tick seeded to ${maxTStar + 1} (max known t_star: ${maxTStar})`);
    } else {
      // Real engine: advance by burning ticks. Safe because t_star only increments
      // once per definition deployment (typically < 10 000 total).
      let current = eng.clockTick();
      while (Number(current) <= maxTStar) current = eng.clockTick();
      console.log(`[server] APV engine clock advanced to ${current} (max known t_star: ${maxTStar})`);
    }
  }
} catch (e) {
  console.warn(`[server] Tick seeding failed (non-fatal): ${e.message}`);
}

if (!process.env.STATEKEEP_MULTI_INSTANCE_WARNED) {
  fastify.log.warn(
    'StateKeep uses SQLite — only one writer process should be running at a time. ' +
    'Set STATEKEEP_MULTI_INSTANCE_WARNED=true to suppress this warning.'
  );
}

try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`StateKeep API listening on port ${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
