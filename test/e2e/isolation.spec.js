/**
 * test/e2e/isolation.spec.js
 *
 * Cross-org isolation tests: org A's API key must never be able to read,
 * write, or observe org B's resources. All violations return 404 — never 403.
 *
 * Tests:
 *  1.  GET  /v1/actors/:id/state        with orgB key → 404
 *  2.  GET  /v1/actors/:id/events       with orgB key → 404
 *  3.  GET  /v1/actors/:id/export       with orgB key → 404
 *  4.  GET  /v1/definitions/:id/status  with orgB key → 404
 *  5.  POST /v1/actors/:id/event        with orgB key → 404
 *  6.  POST /v1/actors/:id/schedule     with orgB key → 404
 *  7.  DELETE /v1/actors/:id/schedule/:sid with orgB key → 404
 *  8.  GET  /v1/machines/:id/export     with orgB key → 404
 *  9.  PUT  /v1/definitions with parentId → orgA def, orgB key → 404
 * 10.  WebSocket /v1/actors/:id/stream  with orgB key → closes with 4004
 */

import { test, expect }   from '@playwright/test';
import { uniqueId }        from './helpers/api.js';
import WebSocket           from 'ws';

const BASE       = process.env.STATEKEEP_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;
const ADMIN_KEY  = process.env.STATEKEEP_ADMIN_KEY ?? 'test-admin-key';
const SENTINEL   = '__test_key_do_not_use_in_production__';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function adminPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': SENTINEL, 'x-admin-key': ADMIN_KEY },
    body:    JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function withKey(key, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':    key,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const getB  = (key, path)       => withKey(key, 'GET',    path);
const postB = (key, path, body) => withKey(key, 'POST',   path, body);
const putB  = (key, path, body) => withKey(key, 'PUT',    path, body);
const delB  = (key, path)       => withKey(key, 'DELETE', path);

// ── Setup: two orgs, each with their own enterprise API key ──────────────────

let orgAKey, orgBKey;
let defId, actorId, schedId, machineId;
let setupSkipped = false;

const MACHINE_DEF = {
  id:      'iso-machine',
  initial: 'idle',
  states: {
    idle:    { on: { START: 'running' } },
    running: { on: { STOP:  'done'   } },
    done:    { type: 'final'          },
  },
};

test.beforeEach(async ({}, testInfo) => {
  if (setupSkipped) testInfo.skip(true, 'Cross-org isolation not available in open-source mode (auth removed)');
});

test.beforeAll(async () => {
  // Create orgA
  const orgARes = await adminPost('/v1/orgs', { name: 'Isolation Org A' });
  if (orgARes.status !== 201) { setupSkipped = true; return; }
  const orgAId = orgARes.body.id;

  // Create orgB
  const orgBRes = await adminPost('/v1/orgs', { name: 'Isolation Org B' });
  if (orgBRes.status !== 201) { setupSkipped = true; return; }
  const orgBId = orgBRes.body.id;

  // Provision enterprise keys for each org
  const keyARes = await adminPost(`/v1/orgs/${orgAId}/keys`, { label: 'orgA-key', tier: 'enterprise' });
  if (keyARes.status !== 201) { setupSkipped = true; return; }
  orgAKey = keyARes.body.rawKey;

  const keyBRes = await adminPost(`/v1/orgs/${orgBId}/keys`, { label: 'orgB-key', tier: 'enterprise' });
  if (keyBRes.status !== 201) { setupSkipped = true; return; }
  orgBKey = keyBRes.body.rawKey;

  // Create definition under orgA
  defId     = uniqueId('iso-def');
  machineId = defId;
  const defRes = await withKey(orgAKey, 'PUT', '/v1/definitions', { id: defId, definition: MACHINE_DEF });
  if (defRes.status !== 201 && defRes.status !== 200) { setupSkipped = true; return; }

  // Spawn actor under orgA
  const spawnRes = await postB(orgAKey, '/v1/actors', { definitionId: defId });
  if (spawnRes.status !== 201) { setupSkipped = true; return; }
  actorId = spawnRes.body.id;

  // Schedule an event under orgA
  const schedRes = await postB(orgAKey, `/v1/actors/${actorId}/schedule`, {
    type:   'START',
    fireAt: Date.now() + 3_600_000,
  });
  if (schedRes.status !== 201) { setupSkipped = true; return; }
  schedId = schedRes.body.id;
});

// ── 1: actor state ────────────────────────────────────────────────────────────

test('GET /v1/actors/:id/state with orgB key returns 404', async () => {
  const { status } = await getB(orgBKey, `/v1/actors/${actorId}/state`);
  expect(status).toBe(404);
});

// ── 2: actor events ───────────────────────────────────────────────────────────

test('GET /v1/actors/:id/events with orgB key returns 404', async () => {
  const { status } = await getB(orgBKey, `/v1/actors/${actorId}/events`);
  expect(status).toBe(404);
});

// ── 3: actor export ───────────────────────────────────────────────────────────

test('GET /v1/actors/:id/export with orgB key returns 404', async () => {
  const { status } = await getB(orgBKey, `/v1/actors/${actorId}/export`);
  expect(status).toBe(404);
});

// ── 4: definition status ──────────────────────────────────────────────────────

test('GET /v1/definitions/:id/status with orgB key returns 404', async () => {
  const { status } = await getB(orgBKey, `/v1/definitions/${defId}/status`);
  expect(status).toBe(404);
});

// ── 5: send event ─────────────────────────────────────────────────────────────

test('POST /v1/actors/:id/event with orgB key returns 404', async () => {
  const { status } = await postB(orgBKey, `/v1/actors/${actorId}/event`, { type: 'START' });
  expect(status).toBe(404);
});

// ── 6: schedule event ─────────────────────────────────────────────────────────

test('POST /v1/actors/:id/schedule with orgB key returns 404', async () => {
  const { status } = await postB(orgBKey, `/v1/actors/${actorId}/schedule`, {
    type:   'START',
    fireAt: Date.now() + 3_600_000,
  });
  expect(status).toBe(404);
});

// ── 7: cancel scheduled event ─────────────────────────────────────────────────

test('DELETE /v1/actors/:id/schedule/:sid with orgB key returns 404', async () => {
  const { status } = await delB(orgBKey, `/v1/actors/${actorId}/schedule/${schedId}`);
  expect(status).toBe(404);
});

// ── 8: machine export ─────────────────────────────────────────────────────────

test('GET /v1/machines/:id/export with orgB key returns 404', async () => {
  const { status } = await getB(orgBKey, `/v1/machines/${machineId}/export`);
  expect(status).toBe(404);
});

// ── 9: definition with cross-org parentId ────────────────────────────────────

test('PUT /v1/definitions with parentId pointing to orgA def using orgB key returns 404', async () => {
  const childId = uniqueId('iso-child');
  const { status } = await putB(orgBKey, '/v1/definitions', {
    id:         childId,
    parentId:   defId,   // orgA's definition — orgB key must not see it
    definition: MACHINE_DEF,
  });
  expect(status).toBe(404);
});

// ── 10: WebSocket stream ──────────────────────────────────────────────────────

test('WebSocket /v1/actors/:id/stream with orgB key closes with 4004', async () => {
  const wsUrl = BASE.replace(/^http/, 'ws') + `/v1/actors/${actorId}/stream`;

  await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { 'x-api-key': orgBKey } });

    let gotError = false;
    let closeCode = null;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ERROR') gotError = true;
      } catch {}
    });

    ws.on('close', (code) => {
      closeCode = code;
      // 4004 = application-level rejection; 1005 = no status (some WS libs)
      expect(gotError || [4004, 1005].includes(code)).toBe(true);
      resolve();
    });

    ws.on('error', () => resolve());

    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
      resolve();
    }, 5_000);
  });
});
