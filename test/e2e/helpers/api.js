/**
 * test/e2e/helpers/api.js
 * Thin fetch wrapper for E2E API calls.
 */

const BASE = process.env.STATEKEEP_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;

export async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, body: json };
}

export const GET    = (path)        => api('GET',    path);
export const POST   = (path, body)  => api('POST',   path, body);
export const PUT    = (path, body)  => api('PUT',    path, body);
export const DELETE = (path)        => api('DELETE', path);
export const PATCH  = (path, body)  => api('PATCH',  path, body);

// ── Common fixtures ──────────────────────────────────────────────────────────

export const SIMPLE_MACHINE = {
  id:      'idle',
  initial: 'idle',
  states: {
    idle:    { on: { START: 'running' } },
    running: { on: { STOP: 'done' } },
    done:    { type: 'final' },
  },
};

export const SIMPLE_MACHINE_V2 = {
  id:      'idle',
  initial: 'idle',
  states: {
    idle:    { on: { START: 'running', CANCEL: 'cancelled' } },
    running: { on: { STOP: 'done' } },
    cancelled: { type: 'final' },
    done:    { type: 'final' },
  },
};

export function uniqueId(prefix = 'test') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Poll until a condition is met or timeout is reached.
 * Never use setTimeout for waiting on async system state.
 */
export async function waitUntil(conditionFn, opts = {}) {
  const { timeoutMs = 10_000, intervalMs = 200, description = 'condition' } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for: ${description} (${timeoutMs}ms)`);
}

/** Wait until an actor reaches a specific definitionId (used for migration waits). */
export async function waitForActorMigration(actorId, targetDefId) {
  await waitUntil(
    async () => {
      const r    = await GET(`/v1/actors/${actorId}/state`);
      return r.body.definitionId === targetDefId;
    },
    { timeoutMs: 10_000, description: `actor ${actorId} to reach ${targetDefId}` }
  );
}

/** Wait until an actor reaches a specific stateValue. */
export async function waitForActorState(actorId, targetState) {
  await waitUntil(
    async () => {
      const r  = await GET(`/v1/actors/${actorId}/state`);
      const sv = r.body.stateValue;
      const val = typeof sv === 'string' ? sv : Object.keys(sv ?? {})[0];
      return val === targetState;
    },
    { timeoutMs: 10_000, description: `actor ${actorId} to reach state ${targetState}` }
  );
}
