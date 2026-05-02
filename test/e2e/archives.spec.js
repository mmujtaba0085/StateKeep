/**
 * test/e2e/archives.spec.js
 *
 * Tests for actor archival and restore.
 *
 * The gc-worker runs every 60 s which is too slow for E2E. Instead these tests
 * use POST /v1/admin/actors/:id/force-archive (admin-only, non-production) to
 * trigger the same archive logic synchronously.
 */

import { test, expect } from '@playwright/test';
import { GET, POST, PUT, DELETE, uniqueId } from './helpers/api.js';

const BASE      = process.env.STATEKEEP_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;
const ADMIN_KEY = process.env.STATEKEEP_ADMIN_KEY ?? 'test-admin-key';
const SENTINEL  = '__test_key_do_not_use_in_production__';

const MACHINE_DEF = {
  id:      'arc-machine',
  initial: 'idle',
  states: {
    idle:    { on: { START: 'running' } },
    running: { on: { STOP: 'done'    } },
    done:    { type: 'final'          },
  },
};

// Admin helpers
async function adminPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':    SENTINEL,
      'x-admin-key':  ADMIN_KEY,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function forceArchive(actorId) {
  return adminPost(`/v1/admin/actors/${actorId}/force-archive`, {});
}

// ── Setup: shared definition ──────────────────────────────────────────────────

let defId;

test.beforeAll(async () => {
  defId = uniqueId('arc-def');
  const res = await PUT('/v1/definitions', { id: defId, definition: MACHINE_DEF });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Setup: failed to create definition (${res.status})`);
  }
});

// Helper: spawn actor, advance one event, return actor id
async function spawnAndAdvance() {
  const spawn = await POST('/v1/actors', { definitionId: defId });
  expect(spawn.status).toBe(201);
  const id = spawn.body.id;
  await POST(`/v1/actors/${id}/event`, { type: 'START' });
  return id;
}

// ── 1: force-archive moves actor to archived ──────────────────────────────────

test('force-archive moves actor to archived status', async () => {
  const id  = await spawnAndAdvance();
  const arc = await forceArchive(id);
  expect(arc.status).toBe(200);
  expect(arc.body.archivedAt).toBeTruthy();
  expect(arc.body.filePath).toBeTruthy();

  const stateRes = await GET(`/v1/actors/${id}/state`);
  expect(stateRes.body.status).toBe('archived');
});

// ── 2: archived actor appears in GET /v1/archives ─────────────────────────────

test('archived actor appears in GET /v1/archives', async () => {
  const id = await spawnAndAdvance();
  await forceArchive(id);

  const listRes = await GET('/v1/archives');
  expect(listRes.status).toBe(200);
  expect(Array.isArray(listRes.body.archives)).toBe(true);

  const found = listRes.body.archives.find(a => a.actorId === id);
  expect(found).toBeDefined();
  expect(found.machineId).toBeTruthy();
  expect(found.stateValue).toBeTruthy();  // was in 'running' state
  expect(found.archivedAt).toBeTruthy();
});

// ── 3: machineId filter ───────────────────────────────────────────────────────

test('GET /v1/archives filters by machineId', async () => {
  // Create a second definition (different machine family)
  const altDefId = uniqueId('arc-alt');
  await PUT('/v1/definitions', {
    id:         altDefId,
    definition: { id: 'alt', initial: 'idle', states: { idle: { type: 'final' } } },
  });

  // Archive one actor from each family
  const idA = (await POST('/v1/actors', { definitionId: defId })).body.id;
  await forceArchive(idA);

  const idB = (await POST('/v1/actors', { definitionId: altDefId })).body.id;
  await forceArchive(idB);

  // Filter by the main defId (= machineId of the main machine)
  const res = await GET(`/v1/archives?machineId=${defId}`);
  expect(res.status).toBe(200);

  // All returned items should have the right machineId
  res.body.archives.forEach(a => {
    expect(a.machineId).toBe(defId);
  });

  // The alt actor must not appear
  const foundAlt = res.body.archives.find(a => a.actorId === idB);
  expect(foundAlt).toBeUndefined();
});

// ── 4: restore actor to active ────────────────────────────────────────────────

test('POST /v1/actors/:id/restore restores archived actor to active', async () => {
  const id = await spawnAndAdvance();
  await forceArchive(id);

  const restoreRes = await POST(`/v1/actors/${id}/restore`, {});
  expect([200, 201]).toContain(restoreRes.status);

  const stateRes = await GET(`/v1/actors/${id}/state`);
  expect(stateRes.body.status).toBe('active');
  expect(stateRes.body.stateValue).toBe('running');
});

// ── 5: restored actor accepts events ─────────────────────────────────────────

test('restored actor accepts events normally', async () => {
  const id = await spawnAndAdvance();
  await forceArchive(id);
  await POST(`/v1/actors/${id}/restore`, {});

  const evRes = await POST(`/v1/actors/${id}/event`, { type: 'STOP' });
  expect(evRes.status).toBe(200);
  expect(evRes.body.stateValue).toBe('done');
});

// ── 6: restored actor disappears from archives ────────────────────────────────

test('restored actor disappears from GET /v1/archives', async () => {
  const id = await spawnAndAdvance();
  await forceArchive(id);

  // Confirm it's there
  const before = await GET('/v1/archives');
  expect(before.body.archives.find(a => a.actorId === id)).toBeDefined();

  await POST(`/v1/actors/${id}/restore`, {});

  const after = await GET('/v1/archives');
  expect(after.body.archives.find(a => a.actorId === id)).toBeUndefined();
});

// ── 7: cross-org: org A cannot restore org B actor ────────────────────────────

test('cross-org: org B cannot restore org A archived actor', async () => {
  // Create a second org with its own key
  const orgBRes = await fetch(`${BASE}/v1/orgs`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':    SENTINEL,
      'x-admin-key':  ADMIN_KEY,
    },
    body: JSON.stringify({ name: uniqueId('arc-orgB') }),
  });
  expect(orgBRes.status).toBe(201);
  const orgBId = (await orgBRes.json()).id;

  const keyBRes = await fetch(`${BASE}/v1/orgs/${orgBId}/keys`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':    SENTINEL,
      'x-admin-key':  ADMIN_KEY,
    },
    body: JSON.stringify({ label: 'B', tier: 'enterprise' }),
  });
  expect(keyBRes.status).toBe(201);
  const orgBKey = (await keyBRes.json()).rawKey;

  // Archive an actor from the default org
  const id = await spawnAndAdvance();
  await forceArchive(id);

  // Attempt restore with org B key → must be 404 (cross-org always 404, not 403)
  const res = await fetch(`${BASE}/v1/actors/${id}/restore`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': orgBKey },
    body:    JSON.stringify({}),
  });
  expect(res.status).toBe(404);
});

// ── 8: empty archives for org with no archives ────────────────────────────────

test('GET /v1/archives for org with no archives returns empty array', async () => {
  // Create a fresh org with its own key — no actors ever archived
  const orgRes = await fetch(`${BASE}/v1/orgs`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': SENTINEL, 'x-admin-key': ADMIN_KEY },
    body:    JSON.stringify({ name: uniqueId('arc-empty-org') }),
  });
  expect(orgRes.status).toBe(201);
  const orgId = (await orgRes.json()).id;

  const keyRes = await fetch(`${BASE}/v1/orgs/${orgId}/keys`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': SENTINEL, 'x-admin-key': ADMIN_KEY },
    body:    JSON.stringify({ label: 'empty', tier: 'enterprise' }),
  });
  expect(keyRes.status).toBe(201);
  const orgKey = (await keyRes.json()).rawKey;

  const res = await fetch(`${BASE}/v1/archives`, {
    headers: { 'x-api-key': orgKey },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.archives)).toBe(true);
  expect(body.archives.length).toBe(0);
  expect(body.count).toBe(0);
});
