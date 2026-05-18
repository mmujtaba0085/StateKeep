/**
 * test/e2e/key-rotation.spec.js
 *
 * E2E tests for API key rotation:
 *  1. Create a new enterprise key
 *  2. Verify the new key works (can list actors)
 *  3. Rotate the key using a different active key (sentinel key)
 *  4. Verify the OLD key is now rejected with 403
 *  5. Verify the NEW (rotated) key works
 *  6. Verify actors created before rotation remain accessible with the new key
 *
 * Notes:
 *  - Uses the test sentinel key '__test_key_do_not_use_in_production__' (tier=enterprise)
 *    to create and rotate keys, since rotating your own active key is forbidden.
 *  - Key management routes require enterprise or pro tier (enforced by requireEnterprise).
 */

import { test, expect } from '@playwright/test';
import { uniqueId, PUT, POST } from './helpers/api.js';

const BASE    = process.env.STATEKEEP_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;
const SENTINEL = '__test_key_do_not_use_in_production__';

/** Make a request with a specific raw API key. */
async function withKey(method, path, key, body) {
  const headers = { 'x-api-key': key };
  if (body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const sentinelGet  = (path)        => withKey('GET',    path, SENTINEL);
const sentinelPost = (path, body)  => withKey('POST',   path, SENTINEL, body);

// ── Setup: deploy a simple machine for actor tests ────────────────────────────

const SIMPLE_DEF = {
  id:      'idle',
  initial: 'idle',
  states: {
    idle:    { on: { START: 'running' } },
    running: { type: 'final' },
  },
};

let defId;
test.beforeAll(async () => {
  defId = uniqueId('key-rot-def');
  await sentinelPost('/v1/definitions', { id: defId, definition: { ...SIMPLE_DEF, id: defId } });
});

// ── 1: Create a new enterprise key ───────────────────────────────────────────

test('POST /v1/keys creates a new enterprise key', async () => {
  const label  = uniqueId('rot-key');
  const res    = await sentinelPost('/v1/keys', { label, tier: 'enterprise' });
  expect(res.status).toBe(201);
  expect(res.body.keyId).toBeTruthy();
  expect(res.body.rawKey).toBeTruthy();
  expect(res.body.label).toBe(label);
  expect(res.body.tier).toBe('enterprise');
});

// ── 2: New key works before rotation ─────────────────────────────────────────

test('new key can access actors endpoint before rotation', async () => {
  const label  = uniqueId('rot-key-pre');
  const create = await sentinelPost('/v1/keys', { label, tier: 'enterprise' });
  expect(create.status).toBe(201);

  const rawKey = create.body.rawKey;
  const res    = await withKey('GET', '/v1/actors', rawKey);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.actors)).toBe(true);
});

// ── 3: Rotate key — old key rejected, new key works ──────────────────────────

test('rotating a key invalidates the old key and returns a new one', async () => {
  const label  = uniqueId('rot-target');
  const create = await sentinelPost('/v1/keys', { label, tier: 'enterprise' });
  expect(create.status).toBe(201);

  const oldKey = create.body.rawKey;
  const keyId  = create.body.keyId;

  // Rotate using sentinel (different key)
  const rotate = await sentinelPost(`/v1/keys/${keyId}/rotate`);
  expect(rotate.status).toBe(200);
  expect(rotate.body.key).toBeTruthy();
  expect(rotate.body.key).not.toBe(oldKey);

  const newKey = rotate.body.key;

  // Old key should be rejected
  const oldRes = await withKey('GET', '/v1/actors', oldKey);
  expect(oldRes.status).toBe(403);

  // New key should work
  const newRes = await withKey('GET', '/v1/actors', newKey);
  expect(newRes.status).toBe(200);
});

// ── 4: Cannot rotate own active key ──────────────────────────────────────────

test('rotating your own active key returns 400', async () => {
  const label  = uniqueId('self-rot');
  const create = await sentinelPost('/v1/keys', { label, tier: 'enterprise' });
  const keyId  = create.body.keyId;
  const rawKey = create.body.rawKey;

  // Try to rotate itself
  const res = await withKey('POST', `/v1/keys/${keyId}/rotate`, rawKey);
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/own active key/i);
});

// ── 5: Actors remain accessible after key rotation ───────────────────────────

test('actors spawned before key rotation are accessible with rotated key', async () => {
  const label  = uniqueId('rot-actor');
  const create = await sentinelPost('/v1/keys', { label, tier: 'enterprise' });
  const oldKey = create.body.rawKey;
  const keyId  = create.body.keyId;

  // Spawn an actor with the old key
  const spawnDef = uniqueId('rot-def');
  await withKey('PUT', '/v1/definitions', oldKey, { id: spawnDef, definition: { ...SIMPLE_DEF, id: spawnDef } });
  const spawn = await withKey('POST', '/v1/actors', oldKey, { definitionId: spawnDef });
  expect(spawn.status).toBe(201);
  const actorId = spawn.body.id;

  // Rotate the key
  const rotate = await sentinelPost(`/v1/keys/${keyId}/rotate`);
  const newKey = rotate.body.key;

  // Actor still accessible with new key
  const actorRes = await withKey('GET', `/v1/actors/${actorId}/state`, newKey);
  expect(actorRes.status).toBe(200);
  expect(actorRes.body.stateValue).toBe('idle');
});

// ── 6: Rotating non-existent key returns 404 ─────────────────────────────────

test('rotating a non-existent keyId returns 404', async () => {
  const res = await sentinelPost('/v1/keys/nonexistent-key-id-xyz/rotate');
  expect(res.status).toBe(404);
});
