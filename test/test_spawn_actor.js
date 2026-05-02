/**
 * test/test_spawn_actor.js
 * Proves: actor creation, initial state, API key auth
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { seedApiKey, post, get, BASE_URL, SAMPLE_MACHINE_V1 } from './setup.js';

let server;

before(async () => {
  await seedApiKey();
  const { put } = await import('./setup.js');
  // Deploy definition first
  await put('/v1/definitions', { id: 'spawn-test-v1', definition: SAMPLE_MACHINE_V1 });
});

after(() => { if (server) server.kill(); });

test('POST /v1/actors returns 201 with initial state', async () => {
  const res = await post('/v1/actors', { definitionId: 'spawn-test-v1' });
  assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.id, 'id should be set');
  assert.ok(res.body.stateValue, 'stateValue should be set');
  assert.equal(res.body.stateValue, 'idle', 'Initial state should be idle');
});

test('POST /v1/actors with missing definition returns 400', async () => {
  const res = await post('/v1/actors', { definitionId: 'nonexistent-def' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});

test('POST /v1/actors without API key returns 401', async () => {
  const res = await fetch(`${BASE_URL}/v1/actors`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ definitionId: 'spawn-test-v1' }),
  });
  assert.equal(res.status, 401);
});

test('POST /v1/actors with wrong API key returns 403', async () => {
  const res = await post('/v1/actors', { definitionId: 'spawn-test-v1' }, { 'X-API-Key': 'bad-key' });
  assert.equal(res.status, 403);
});

test('GET /v1/health requires no auth', async () => {
  const res = await fetch(`${BASE_URL}/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});
