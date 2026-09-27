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
 * Request body: { actorId, definitionId, state, context, event } (+ jobId for actions).
 * Actions are at-least-once: a retry after a crash can repeat a call, so a service
 * with side effects should dedupe on `jobId` (the Python SDK does this for you).
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

/**
 * Errors carry `sent`: false when the request certainly never reached the service
 * (connection refused, DNS failure) — safe to retry for any action; true when it may
 * have been processed (timeout, connection reset, HTTP 5xx) — see docs/side-effects.md.
 * An HTTP 4xx is the service refusing the request, so nothing happened: sent=false
 * (except 409 IN_PROGRESS: the job was started earlier and never finished).
 */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

async function callRemote(method, path, payload, extraHeaders = {}) {
  const { url, secret, timeoutMs } = cfg();
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const ts   = String(Date.now());
  let res;
  try {
    res = await fetch(`${url}${path}`, {
      method,
      headers: {
        'Content-Type':          'application/json',
        'X-StateKeep-Timestamp': ts,
        'X-StateKeep-Signature': signBody(secret, ts, body),
        ...extraHeaders,
      },
      body:   method === 'GET' ? undefined : body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const code = err?.cause?.code ?? err?.code;
    throw Object.assign(new Error(`remote ${path}: ${err.name === 'TimeoutError' ? `no answer within ${timeoutMs}ms` : (code ?? err.message)}`),
      { sent: !NOT_SENT_CODES.has(code) });
  }
  let text;
  try { text = await res.text(); }
  catch (err) { throw Object.assign(new Error(`remote ${path}: response lost (${err.message})`), { sent: true }); }
  if (!res.ok) {
    throw Object.assign(new Error(`remote ${path} → HTTP ${res.status} ${text.slice(0, 200)}`),
      // 409 IN_PROGRESS: the service already started this job and it never finished
      { sent: res.status >= 500 || res.status === 409, status: res.status });
  }
  return text ? JSON.parse(text) : {};
}

// ── Manifest ────────────────────────────────────────────────────────────────
let manifest = { guards: new Set(), actions: new Set(), delivery: {}, fetchedAt: 0 };
export const DELIVERY_MODES = new Set(['idempotent', 'verify', 'at-most-once']);
const MANIFEST_TTL_MS = 30_000;

export async function refreshRemoteManifest({ force = false } = {}) {
  if (!remoteEnabled()) return manifest;
  if (!force && Date.now() - manifest.fetchedAt < MANIFEST_TTL_MS) return manifest;
  try {
    const m = await callRemote('GET', '/manifest');
    const delivery = {};
    for (const [name, mode] of Object.entries(m.delivery ?? {})) if (DELIVERY_MODES.has(mode)) delivery[name] = mode;
    manifest = { guards: new Set(m.guards ?? []), actions: new Set(m.actions ?? []), delivery, fetchedAt: Date.now() };
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
    if (c?.guard && typeof c.guard === 'string' && !localGuards[c.guard] && !c.guard.startsWith('cond:')) names.add(c.guard);
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
  // Returns the service's answer; the action-job worker delivers any `send` follow-up
  // (exactly once) after recording that the action succeeded.
  const run = async ({ context, event }, meta = {}) =>
    callRemote('POST', `/actions/${encodeURIComponent(name)}`,
      { actorId: meta.actorId ?? null, jobId: meta.jobId ?? null, context, event, ...(meta.rerunApproved ? { rerunApproved: true } : {}) },
      meta.jobId ? { 'Idempotency-Key': String(meta.jobId) } : {});
  // "Did job X happen?" → { done: true, send? } | { done: false } | { done: null } (nobody knows)
  const verify = async ({ context, event }, meta = {}) =>
    callRemote('POST', `/actions/${encodeURIComponent(name)}/status`,
      { actorId: meta.actorId ?? null, jobId: meta.jobId ?? null, context, event });
  const opts = { backoff: 'exponential', timeout: cfg().timeoutMs, originalFn: run, verify, remote: true };
  // Retrying an idempotent action is always safe, so it gets a bigger budget before a
  // human is asked; the others stop sooner.
  Object.defineProperty(opts, 'maxRetries', { enumerable: true, get: () => (manifest.delivery[name] === 'idempotent' ? 10 : 5) });
  // Undeclared actions get the safe default: never repeated when the outcome is unknown.
  Object.defineProperty(opts, 'delivery', { enumerable: true, get: () => manifest.delivery[name] ?? 'at-most-once' });
  const stub = (...args) => run(...args);
  stub.__sk_durable = opts;
  actionStubs.set(name, stub);
  return stub;
}

import { conditionGuard } from './conditionGuards.js';

const RESERVED = new Set(['then', 'toJSON', 'constructor', 'prototype', '__proto__', 'hasOwnProperty', 'valueOf', 'toString', 'inspect']);

/**
 * Wrap a registry with the built-in extensions:
 *   - `cond:<expression>` guards (see conditionGuards.js) — always available
 *   - names missing locally but listed in the remote manifest → remote stubs
 * Local implementations always take precedence.
 */
export function withRemote(registry, { strict = false } = {}) {
  const base   = registry ?? { guards: {}, actions: {}, services: {} };
  // strict (deploy-time validation): only names the service's manifest lists count as
  // implemented, so typos are caught before anything runs.
  const remote = remoteEnabled();
  const hasGuard  = (n) => !strict || isRemoteGuard(n);
  const hasAction = (n) => !strict || isRemoteAction(n);
  // With a remote service configured, every name that is not implemented locally is the
  // service's — whether or not its manifest could be fetched just now. (Deciding by the
  // manifest meant a server that restarted during a service outage silently dropped
  // durable actions and treated remote guards as missing.) Names are checked against the
  // manifest when a definition is deployed.
  const special = (name) => typeof name !== 'string' || RESERVED.has(name);
  const guards = new Proxy(base.guards ?? {}, {
    get: (t, name) => {
      if (special(name) || name in t) return t[name];
      return conditionGuard(name) ?? (remote && hasGuard(name) ? remoteGuardStub(name) : undefined);
    },
  });
  const actions = remote ? new Proxy(base.actions ?? {}, {
    get: (t, name) => (!special(name) && !(name in t) && hasAction(name)) ? remoteActionStub(name) : t[name],
  }) : (base.actions ?? {});
  return { ...base, guards, actions };
}
