/**
 * test/helpers/serverHelper.js
 *
 * Starts the Fastify server in-process for integration tests.
 * Returns a `stop()` function and the running server instance.
 *
 * Import AFTER setup.js has configured env vars (DB path, key, port).
 */

import { once } from 'events';

let _server = null;

export async function startServer() {
  if (_server) return _server;

  const base = `http://127.0.0.1:${process.env.PORT || 3099}`;

  // If a server is already running (e.g. a deployed instance), use it directly.
  // Importing server.js when the port is occupied causes process.exit(1) in server.js.
  try {
    const res = await fetch(`${base}/v1/health`);
    if (res.ok) {
      _server = { base, stop: () => Promise.resolve() };
      return _server;
    }
  } catch {}

  // No server running — start one by importing server.js.
  const mod = await import('../../src/api/server.js').catch(() => null);
  if (!mod) {
    // Server exports nothing — it starts itself; wait for it to be ready.
    await new Promise(r => setTimeout(r, 800));
  }

  // Poll until the health endpoint responds
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${base}/v1/health`);
      if (res.ok) {
        _server = { base, stop: () => Promise.resolve() };
        return _server;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Server failed to start within 4s');
}

export async function stopServer() {
  _server = null;
}

/**
 * Convenience: wait for a deployment to reach a terminal status.
 * Polls GET /v1/definitions/:defId/status every 200ms.
 */
export async function waitForDeployment(request, defId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await request('GET', `/v1/definitions/${defId}/status`);
    if (r.status === 200 && Array.isArray(r.body?.deployments)) {
      const dep = r.body.deployments[0];
      if (dep && (dep.status === 'complete' || dep.status === 'failed')) {
        return dep;
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Deployment for ${defId} did not complete within ${timeoutMs}ms`);
}

/**
 * Seed a definition via PUT /v1/definitions and return its ID.
 */
export async function seedDefinition(request, id, machine) {
  const r = await request('PUT', '/v1/definitions', { id, definition: machine });
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`seedDefinition failed (${r.status}): ${JSON.stringify(r.body)}`);
  }
  return id;
}

/**
 * Spawn N actors against a definition and return their IDs.
 */
export async function spawnActors(request, definitionId, n, contextOverride = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = await request('POST', '/v1/actors', {
      definitionId,
      initialContext: { ...contextOverride, seqIndex: i },
    });
    if (r.status !== 201) throw new Error(`spawnActors failed at i=${i}: ${JSON.stringify(r.body)}`);
    ids.push(r.body.id);
  }
  return ids;
}

/**
 * Drive an actor through a sequence of events. Returns the last event response body.
 */
export async function driveActor(request, actorId, events) {
  let last;
  for (const evt of events) {
    const r = await request('POST', `/v1/actors/${actorId}/event`, evt);
    if (r.status !== 200) throw new Error(`driveActor failed on event ${evt.type}: ${JSON.stringify(r.body)}`);
    last = r.body;
  }
  return last;
}
