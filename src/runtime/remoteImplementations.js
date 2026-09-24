/**
 * src/runtime/remoteImplementations.js
 *
 * Guards and actions implemented by the team's own HTTP service, in any language.
 * Until now they had to be a JavaScript module loaded into the StateKeep process
 * (STATEKEEP_REGISTRY_PATH), which excluded Python / Go / Java / .NET teams.
 *
 * Configure (operator-controlled, so internal addresses are allowed):
 *   STATEKEEP_REMOTE_URL          e.g. http://credit-service.internal:8080/statekeep
 *   STATEKEEP_REMOTE_SECRET       shared secret for request signing (required)
 *   STATEKEEP_REMOTE_TIMEOUT_MS   per-call timeout (default 5000)
 *
 * The service implements:
 *   GET  {url}/manifest               → { "guards": ["isCreditOk"], "actions": ["sendOffer"] }
 *   POST {url}/guards/{name}          → { "result": true | false }
 *   POST {url}/actions/{name}         → {} or { "send": { "type": "EVENT", ...payload } }
 * Request body: { actorId, definitionId, state, context, event }.
 * Every request carries X-StateKeep-Timestamp and
 * X-StateKeep-Signature: sha256=HMAC(secret, `${timestamp}.${body}`).
 *
 * Semantics
 * - Local registry entries always win; remote names come from the manifest.
 * - Guards: the interpreter is synchronous, so remote guards that the incoming event
 *   can reach are evaluated BEFORE the transition (in parallel) against the actor's
 *   pre-event context, and their results are fed to the interpreter. A guard that
 *   errors or times out evaluates to false (same rule as a throwing local guard).
 *   Limitation: guards on `always` transitions reached after an action changed the
 *   context see the pre-event context.
 * - Actions: remote actions are durable jobs, committed with the transition and
 *   retried with backoff by the action-job worker. A `send` in the response is
 *   delivered to the actor as a follow-up event (the async way to feed results back).
 */

import { createHmac } from 'crypto';

const cfg = () => ({
  url:       (process.env.STATEKEEP_REMOTE_URL ?? '').replace(/\/+$/, ''),
  secret:    process.env.STATEKEEP_REMOTE_SECRET ?? '',
  timeoutMs: parseInt(process.env.STATEKEEP_REMOTE_TIMEOUT_MS ?? '5000', 10),
});

export function remoteEnabled() {
  const { url, secret } = cfg();
  return !!(url && secret);
}

export function signBody(secret, timestamp, body) {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function callRemote(method, path, payload) {
  const { url, secret, timeoutMs } = cfg();
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const ts   = String(Date.now());
  const res  = await fetch(`${url}${path}`, {
    method,
    headers: {
      'Content-Type':          'application/json',
      'X-StateKeep-Timestamp': ts,
      'X-StateKeep-Signature': signBody(secret, ts, body),
    },
    body:   method === 'GET' ? undefined : body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`remote ${path} → HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// ── Manifest ────────────────────────────────────────────────────────────────
let manifest = { guards: new Set(), actions: new Set(), fetchedAt: 0 };
const MANIFEST_TTL_MS = 30_000;

export async function refreshRemoteManifest({ force = false } = {}) {
  if (!remoteEnabled()) return manifest;
  if (!force && Date.now() - manifest.fetchedAt < MANIFEST_TTL_MS) return manifest;
  try {
    const m = await callRemote('GET', '/manifest');
    manifest = { guards: new Set(m.guards ?? []), actions: new Set(m.actions ?? []), fetchedAt: Date.now() };
  } catch (err) {
    console.warn(`[remote] manifest fetch failed: ${err.message}`);
  }
  return manifest;
}
export const isRemoteGuard  = (name) => remoteEnabled() && manifest.guards.has(name);
export const isRemoteAction = (name) => remoteEnabled() && manifest.actions.has(name);

// ── Guards: pre-evaluated results for the event being processed ──────────────
// processEvent() is synchronous, so results are placed here immediately before it
// runs and cleared right after (no await in between → no interleaving).
let currentGuardResults = null;
export function setCurrentGuardResults(map) { currentGuardResults = map; }

function remoteGuardStub(name) {
  return () => currentGuardResults?.get(name) ?? false;
}

/** Guard names reachable by `event` (event transitions + eventless ones), not implemented locally. */
function reachableRemoteGuards(compiledJson, eventType, localGuards) {
  const names = new Set();
  const consider = (c) => {
    if (c?.guard && typeof c.guard === 'string' && !localGuards[c.guard] && isRemoteGuard(c.guard)) names.add(c.guard);
  };
  for (const [key, candidates] of Object.entries(compiledJson.transitions ?? {})) {
    if (key.endsWith(`:${eventType}`)) (candidates ?? []).forEach(consider);
  }
  for (const c of Object.values(compiledJson.transientStates ?? {})) (Array.isArray(c) ? c : [c]).forEach(consider);
  return [...names];
}

export async function prefetchRemoteGuards({ compiledJson, event, entry, actorId, localGuards }) {
  if (!remoteEnabled()) return null;
  await refreshRemoteManifest();
  const names = reachableRemoteGuards(compiledJson, event.type, localGuards ?? {});
  if (names.length === 0) return null;
  const payload = { actorId, definitionId: entry.definitionId, state: entry.stateValue, context: entry.context, event };
  const results = new Map();
  await Promise.all(names.map(async (name) => {
    try {
      const r = await callRemote('POST', `/guards/${encodeURIComponent(name)}`, payload);
      results.set(name, r.result === true);
    } catch (err) {
      console.warn(`[remote] guard '${name}' failed → false: ${err.message}`);
      results.set(name, false);
    }
  }));
  return results;
}

// ── Actions: durable stubs executed by the action-job worker ────────────────
const actionStubs = new Map();
function remoteActionStub(name) {
  if (actionStubs.has(name)) return actionStubs.get(name);
  const run = async ({ context, event }, meta = {}) => {
    const r = await callRemote('POST', `/actions/${encodeURIComponent(name)}`,
      { actorId: meta.actorId ?? null, context, event });
    if (r && r.send && typeof r.send.type === 'string' && meta.sendEvent) {
      await meta.sendEvent(r.send);
    }
  };
  const stub = (...args) => run(...args);
  stub.__sk_durable = { maxRetries: 5, backoff: 'exponential', timeout: cfg().timeoutMs, originalFn: run, remote: true };
  actionStubs.set(name, stub);
  return stub;
}

import { conditionGuard } from './conditionGuards.js';

/**
 * Wrap a registry with the built-in extensions:
 *   - `cond:<expression>` guards (see conditionGuards.js) — always available
 *   - names missing locally but listed in the remote manifest → remote stubs
 * Local implementations always take precedence.
 */
export function withRemote(registry) {
  const base   = registry ?? { guards: {}, actions: {}, services: {} };
  const remote = remoteEnabled();
  const guards = new Proxy(base.guards ?? {}, {
    get: (t, name) => {
      if (typeof name !== 'string' || name in t) return t[name];
      return conditionGuard(name) ?? ((remote && isRemoteGuard(name)) ? remoteGuardStub(name) : undefined);
    },
  });
  const actions = remote ? new Proxy(base.actions ?? {}, {
    get: (t, name) => (typeof name === 'string' && !(name in t) && isRemoteAction(name)) ? remoteActionStub(name) : t[name],
  }) : (base.actions ?? {});
  return { ...base, guards, actions };
}
