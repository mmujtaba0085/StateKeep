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
import { mkdirSync, readFileSync } from 'fs';
const PKG_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
import { randomUUID } from 'crypto';

import { engineReady, getEngine } from '../ffi/engine.js';
import { getDb, isPostgres } from '../registry/db.js';
import { getMaxKnownTick as getMaxTStar } from '../registry/changepointRepo.js';
import { seedEngineRegistry, sendEvent, startStrandedSweep } from '../runtime/actorManager.js';
import { getGlobalRegistry, setGlobalRegistry, loadRegistry } from '../runtime/implementationRegistry.js';
import { startActionJobWorker } from '../runtime/actionJobWorker.js';
import { deliverEventOnce } from '../runtime/deliverOnce.js';
import { actionJobRoutes } from './routes/actionJobs.js';
import { healthRoutes } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';
import { actorRoutes } from './routes/actors.js';
import { definitionRoutes } from './routes/definitions.js';
import { exportRoutes }     from './routes/export.js';
import { scheduledRoutes }  from './routes/scheduled.js';
import { scenarioRoutes } from './routes/scenarios.js';
import { archiveRoutes } from './routes/archives.js';
import { webhookRoutes } from './routes/webhooks.js';
import { adminRoutes } from './routes/admin.js';
import { internalRoutes } from './routes/internal.js';
import { websocketRoutes } from './websocket.js';
import { importRoutes } from './routes/imports.js';
import { registerSecurity, checkStartupSecurity, securityConfig } from './security.js';

import { registerClusterRouting, startCluster, checkClusterConfig, clusterEnabled } from '../cluster/cluster.js';
import { notifyLocalSubscribers } from './websocket.js';

const _securityProblem = checkStartupSecurity() ?? checkClusterConfig();
if (_securityProblem) {
  console.error(`[server] Refusing to start: ${_securityProblem}`);
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT      = parseInt(process.env.PORT ?? '3001', 10);
const LOG_DIR   = process.env.LOG_DIR ?? './logs';

try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

// ── Logger ────────────────────────────────────────────────────────────────────
const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
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
  // Only trust X-Forwarded-For from proxies you name. Trusting everyone (the old
  // `true`) let any client pick its own IP and so dodge the per-IP rate limit.
  // e.g. STATEKEEP_TRUST_PROXY=loopback (Caddy/nginx on the same host) or a CIDR list.
  trustProxy: (() => {
    const v = process.env.STATEKEEP_TRUST_PROXY;
    if (!v || v === 'false') return false;
    if (v === 'true') return true;
    return v.split(',').map((x) => x.trim()).filter(Boolean);
  })(),
  routerOptions: { maxParamLength: 200 },
  bodyLimit: 1_048_576,
});

// ── Plugins ───────────────────────────────────────────────────────────────────

await fastify.register(FastifySwagger, {
  openapi: {
    info: {
      title:       'StateKeep API',
      description: 'Actor lifecycle management with Anchor-Point Versioning (APV) for zero-downtime statechart migrations.',
      version:     PKG_VERSION,
      contact:     { name: 'StateKeep', url: 'https://github.com/mmujtaba0085/StateKeep', email: 'statekeep.support@gmail.com' },
      license:     { name: 'Apache-2.0 with Commons Clause (source-available)', url: 'https://github.com/mmujtaba0085/StateKeep/blob/master/LICENSE' },
    },
    tags: [
      { name: 'actors',      description: 'Actor lifecycle — spawn, events, state, terminate' },
      { name: 'definitions', description: 'Machine definition deployment and migration' },
      { name: 'webhooks',    description: 'Outbound webhook subscriptions' },
      { name: 'admin',       description: 'Admin operations' },
      { name: 'health',      description: 'Health and metrics' },
    ],
  },
});

await fastify.register(FastifySwaggerUI, {
  routePrefix: '/docs',
  uiConfig:    { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
  staticCSP:   true,
});

// Clients only receive on this socket; cap inbound frames so a peer can't make ws buffer 100 MB (its default).
await fastify.register(FastifyWebSocket, { options: { maxPayload: 4096 } });

if (process.env.STATEKEEP_RATE_LIMIT !== 'false') {
  await fastify.register(FastifyRateLimit, {
    global:     true,
    timeWindow: 60_000,
    max:        parseInt(process.env.STATEKEEP_RATE_LIMIT_MAX ?? '5000', 10),
    allowList:  (_req, _key) => process.env.NODE_ENV === 'test',
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,              // @fastify/rate-limit throws this object; without it the reply was a 500
      error:      'Rate limit exceeded',
      limit:      context.max,
      timeWindow: context.after,
      retryAfter: context.ttl,
    }),
  });
}

// ── JSON bodies: accept an empty body (Fastify 4 behaviour) ──────────────────────
// Fastify 5 rejects `Content-Type: application/json` with an empty body (400
// FST_ERR_CTP_EMPTY_JSON_BODY). The dashboard, SDK and many HTTP clients send that
// header on bodiless DELETE/POST calls, so keep them working. Non-empty bodies still
// go through Fastify's own parser (secure-json-parse, __proto__ poisoning → error).
{
  const defaultJson = fastify.getDefaultJsonParser('error', 'error');
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '' || /^\s*$/.test(body)) return done(null, undefined);
    return defaultJson(req, body, done);
  });
}

// ── Authentication (API key / admin key) — must run before any route handler ──
registerSecurity(fastify);

// ── Multi-server mode: route per-actor requests to the owning server (before routes) ──
registerClusterRouting(fastify);

// ── x-request-id: echo or generate, attach to logger context, set response header ──
fastify.addHook('onRequest', async (req, reply) => {
  const id = req.headers['x-request-id'] ?? randomUUID();
  req.requestId = id;
  req.log = req.log.child({ requestId: id });
  reply.header('X-Request-Id', id);
});

// ── Static dashboard ──────────────────────────────────────────────────────────
// No caching for dashboard JS/JSX — every deploy should be visible immediately.
await fastify.register(FastifyStatic, {
  root:        join(__dirname, '..', 'dashboard'),
  prefix:      '/dashboard/',
  // @fastify/static >= 10 passes the Fastify reply (older versions passed the raw res).
  setHeaders:  (reply) => {
    if (typeof reply.header === 'function') reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    else reply.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  },
});

// ── Routes ────────────────────────────────────────────────────────────────────
await fastify.register(healthRoutes);
await fastify.register(metricsRoutes);
await fastify.register(actorRoutes);
await fastify.register(definitionRoutes);
await fastify.register(importRoutes);
await fastify.register(exportRoutes);
await fastify.register(scheduledRoutes);
await fastify.register(scenarioRoutes);
await fastify.register(archiveRoutes);
await fastify.register(webhookRoutes);
await fastify.register(adminRoutes);
await fastify.register(internalRoutes);
await fastify.register(actionJobRoutes);
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
  <link rel="stylesheet" href="/docs/static/swagger-ui.css">
  <style>
    body { margin: 0; background: #080a0f; }
    .topbar { display: none !important; }
    #swagger-ui { max-width: 1400px; margin: 0 auto; padding: 16px; }
  </style>
</head><body>
<div id="swagger-ui"></div>
<!-- Served locally by @fastify/swagger-ui: no third-party CDN, no floating "@5" version -->
<script src="/docs/static/swagger-ui-bundle.js"></script>
<script>
  let ui;
  ui = SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
    layout: 'BaseLayout',
    deepLinking: true,
    persistAuthorization: true,
    // Reuse the API key the dashboard stored for this tab (if the server requires one).
    requestInterceptor: (req) => {
      try { const k = sessionStorage.getItem('statekeep_api_key'); if (k) req.headers['X-API-Key'] = k; } catch (e) {}
      return req;
    },
    onComplete: () => {}
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
    if (!isPostgres) getDb().close();
  } catch {}
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Startup ───────────────────────────────────────────────────────────────────
await engineReady;

if (isPostgres) {
  const { bootstrapSchema } = await import('../registry/db-postgres.js');
  // A connection dropped by the database while the server boots (restart, failover,
  // pg_terminate_backend) used to crash the start-up; retry for a while instead.
  for (let attempt = 1; ; attempt++) {
    try { await bootstrapSchema(); break; }
    catch (err) {
      const transient = /terminat|ECONN|timeout|Connection|57P0|08\d\d\d/i.test(`${err.code ?? ''} ${err.message ?? ''}`);
      if (!transient || attempt >= 30) throw err;
      console.warn(`[server] database not ready (${err.message}); retrying (${attempt})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.log('[server] Postgres mode — SQLite single-writer warning suppressed');
} else {
  getDb();
}

// Seed APV clock from DB so new deployments get t_star values strictly greater
// than all historical changepoints.  Without this, a server restart resets the
// in-memory counter to 1, causing new definitions to get deployedAt=1 which
// pre-dates all existing actors and breaks the engine's ordering logic.
try {
  const maxTStar = await getMaxTStar();
  if (maxTStar > 0) {
    const eng = getEngine();
    if (!eng.available) {
      eng.seedTick(maxTStar);
      console.log(`[server] Fallback tick seeded to ${maxTStar + 1} (max known t_star: ${maxTStar})`);
    } else {
      // O(1) on current engine builds (apv_clock_advance_to); older builds tick up to it.
      const current = eng.advanceClockTo(maxTStar);
      console.log(`[server] APV engine clock restored to ${current} (highest known tick: ${maxTStar})`);
    }
  }
} catch (e) {
  console.warn(`[server] Tick seeding failed (non-fatal): ${e.message}`);
}

if (!isPostgres && !process.env.STATEKEEP_MULTI_INSTANCE_WARNED) {
  fastify.log.warn(
    'StateKeep uses SQLite — only one writer process should be running at a time. ' +
    'Set STATEKEEP_MULTI_INSTANCE_WARNED=true to suppress this warning.'
  );
}

await seedEngineRegistry();
startStrandedSweep();

// ── Implementation registry ────────────────────────────────────────────────────
// Load guards/actions/services from STATEKEEP_REGISTRY_PATH (if set).
// Missing registry: warn once and continue (no-registry mode, guards silently disabled).
// Bad registry path or invalid export: log the error and exit (misconfiguration, not degraded mode).
{
  const registryPath = process.env.STATEKEEP_REGISTRY_PATH;
  if (registryPath) {
    try {
      const mod = await import(registryPath);
      setGlobalRegistry(loadRegistry({
        guards:   mod.guards   ?? mod.default?.guards   ?? {},
        actions:  mod.actions  ?? mod.default?.actions  ?? {},
        services: mod.services ?? mod.default?.services ?? {},
      }));
      fastify.log.info(`[server] Implementation registry loaded from ${registryPath}`);
    } catch (err) {
      fastify.log.error({ err }, `[server] Failed to load implementation registry from ${registryPath} — exiting`);
      process.exit(1);
    }
  } else {
    fastify.log.warn(
      '[server] STATEKEEP_REGISTRY_PATH is not set — guards, actions, and invoke services are ' +
      'disabled on the HTTP event path. Set STATEKEEP_REGISTRY_PATH to a JS module that exports ' +
      '{ guards, actions, services }.'
    );
  }
}

{
  const { remoteEnabled, refreshRemoteManifest } = await import('../runtime/remoteImplementations.js');
  if (remoteEnabled()) {
    const m = await refreshRemoteManifest({ force: true });
    fastify.log.info(`[server] Remote implementations: ${m.guards.size} guards, ${m.actions.size} actions from ${process.env.STATEKEEP_REMOTE_URL}`);
  } else if (process.env.STATEKEEP_REMOTE_URL && !process.env.STATEKEEP_REMOTE_SECRET) {
    fastify.log.error('[server] STATEKEEP_REMOTE_URL is set but STATEKEEP_REMOTE_SECRET is not — remote implementations disabled');
  }
}

await startCluster(fastify, { onRemoteStateChange: notifyLocalSubscribers });

// In cluster mode the actor may be owned by another server: deliver follow-up events
// through the routed internal dispatch instead of this process's cache.
const _dispatchViaServer = async (actorId, event, idempotencyKey) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/internal/actors/${encodeURIComponent(actorId)}/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': process.env.STATEKEEP_ADMIN_KEY ?? '' },
    body: JSON.stringify({ event, ...(idempotencyKey ? { idempotencyKey } : {}) }),
  });
  if (!res.ok) throw new Error(`dispatch ${res.status}`);
};
// Follow-up events from actions carry an idempotency key → delivered exactly once.
startActionJobWorker(
  (actorId, event, opts = {}) => clusterEnabled()
    ? _dispatchViaServer(actorId, event, opts.idempotencyKey)
    : opts.idempotencyKey
      ? deliverEventOnce(actorId, event, opts.idempotencyKey, { mergePayload: opts.mergePayload ?? null })
      : sendEvent(actorId, event, Date.now(), opts),
  getGlobalRegistry()
);

try {
  const { host, apiKey, allowOpen } = securityConfig();
  await fastify.listen({ port: PORT, host });
  fastify.log.info(`StateKeep API listening on ${host}:${PORT}`);
  // Upgrade legacy (v1) history fingerprints in the background (legacyFingerprints.js).
  setTimeout(async () => {
    try {
      const { upgradeAllLegacyViaOwners } = await import('./routes/admin.js');
      const r = await upgradeAllLegacyViaOwners(fastify);
      if (r.upgraded || r.unverifiable) fastify.log.info(`[server] legacy fingerprints: ${r.upgraded} upgraded, ${r.unverifiable} could not be verified ${JSON.stringify(r.reasons)}`);
    } catch (err) { fastify.log.warn(`[server] legacy fingerprint upgrade: ${err.message}`); }
  }, 3000).unref();
  if (!apiKey) {
    fastify.log.warn(allowOpen
      ? '[server] STATEKEEP_API_KEY is not set and STATEKEEP_ALLOW_UNAUTHENTICATED=true — the API accepts unauthenticated requests from the network.'
      : '[server] STATEKEEP_API_KEY is not set — API is unauthenticated and bound to loopback only. Set STATEKEEP_API_KEY to expose it.');
  }
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
