/**
 * test/e2e/helpers/api.js
 * Thin fetch wrapper for E2E API calls.
 */

const BASE = process.env.STATEKEEP_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;
const KEY  = process.env.STATEKEEP_API_KEY ?? '';

export async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (KEY) headers['x-api-key'] = KEY;

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
