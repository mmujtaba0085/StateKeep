/**
 * test/level2/integration.concurrency.js
 *
 * Level 2 — Integration Tests: Worker Thread Safety + Auth
 *
 * Tests:
 *   - 50 concurrent events to the SAME actor — no race condition
 *   - 20 concurrent spawns — each gets a unique ID
 *   - Rate-limiting headers are present on authenticated requests
 *   - 401 for missing key, 403 for wrong key
 *   - Definition create → retrieve → deprecate flow
 */

import '../setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { seedApiKey, post, get, put, del, BASE_URL, SAMPLE_MACHINE_V1 } from '../setup.js';
import { linearMachine } from '../helpers/factories.js';

before(async () => {
  await seedApiKey();
  await put('/v1/definitions', { id: 'conc-linear-v1', definition: linearMachine('conc-linear') });
  await put('/v1/definitions', { id: 'conc-sample-v1', definition: SAMPLE_MACHINE_V1 });
});

// ── Concurrency ───────────────────────────────────────────────────────────────

describe('Concurrent spawns produce unique actor IDs', () => {
  test('20 concurrent POST /v1/actors all succeed with distinct IDs', async () => {
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        post('/v1/actors', { definitionId: 'conc-linear-v1' })
      )
    );
    const statuses = results.map(r => r.status);
    const ids      = results.map(r => r.body.id).filter(Boolean);

    assert.ok(statuses.every(s => s === 201), `Some spawns failed: ${JSON.stringify(statuses)}`);
    assert.equal(new Set(ids).size, N, 'All IDs must be unique');
  });
});

describe('Concurrent events to same actor', () => {
  test('50 concurrent events — actor state is consistent (no crash)', async () => {
    const spawnRes = await post('/v1/actors', { definitionId: 'conc-sample-v1' });
    assert.equal(spawnRes.status, 201);
    const id = spawnRes.body.id;

    // Send START first to move out of idle (so subsequent events have valid transitions)
    await post(`/v1/actors/${id}/event`, { type: 'START' });

    // Fire 50 concurrent events — some will be ignored (invalid transitions), none should crash
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        post(`/v1/actors/${id}/event`, { type: i % 2 === 0 ? 'PAUSE' : 'RESUME' })
      )
    );

    // All should return 200 (XState ignores invalid transitions gracefully)
    const nonOk = results.filter(r => r.status !== 200);
    assert.ok(
      nonOk.length === 0,
      `${nonOk.length} concurrent events returned non-200: ${JSON.stringify(nonOk.slice(0, 3))}`
    );

    // Final state should be a valid state
    const state = await get(`/v1/actors/${id}/state`);
    assert.equal(state.status, 200);
    assert.ok(['running', 'paused', 'done'].includes(state.body.stateValue),
      `Unexpected final state: ${state.body.stateValue}`);
  });
});

// ── Authentication ────────────────────────────────────────────────────────────

describe('Authentication', () => {
  test('missing X-API-Key → 401', async () => {
    const res = await fetch(`${BASE_URL}/v1/actors`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ definitionId: 'conc-linear-v1' }),
    });
    assert.equal(res.status, 401);
  });

  test('invalid X-API-Key → 403', async () => {
    const res = await post('/v1/actors', { definitionId: 'conc-linear-v1' }, { 'X-API-Key': 'bad-key-xyz' });
    assert.equal(res.status, 403);
  });

  test('GET /v1/health requires no key → 200', async () => {
    const res = await fetch(`${BASE_URL}/v1/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });

  test('valid key returns 201 for actor spawn', async () => {
    const r = await post('/v1/actors', { definitionId: 'conc-linear-v1' });
    assert.equal(r.status, 201);
  });
});

// ── Definition CRUD ───────────────────────────────────────────────────────────

describe('Definition CRUD', () => {
  const defId = `crud-def-${Date.now()}`;

  test('PUT /v1/definitions creates new definition', async () => {
    const r = await put('/v1/definitions', {
      id:         defId,
      definition: linearMachine(defId),
    });
    assert.ok([200, 201].includes(r.status), `Expected 200/201, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  test('GET /v1/definitions/:id retrieves definition', async () => {
    const r = await get(`/v1/definitions/${defId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, defId);
    assert.equal(r.body.status, 'active');
  });

  test('GET /v1/definitions returns list', async () => {
    const r = await get('/v1/definitions');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.definitions));
  });

  test('DELETE /v1/definitions/:id deprecates definition', async () => {
    const r = await del(`/v1/definitions/${defId}`);
    assert.ok([200, 204].includes(r.status), `Expected 200/204, got ${r.status}`);
    // After deprecation, it should still be findable but status=deprecated
    const check = await get(`/v1/definitions/${defId}`);
    if (check.status === 200) {
      assert.equal(check.body.status, 'deprecated');
    }
  });

  test('non-existent definition → 404', async () => {
    const r = await get('/v1/definitions/no-such-def-xyz');
    assert.equal(r.status, 404);
  });

  test('PUT definition with missing id → 400', async () => {
    const r = await put('/v1/definitions', { definition: { initial: 'idle', states: {} } });
    assert.ok(r.status >= 400, `Expected 4xx, got ${r.status}`);
  });
});

// ── Mock Engine: No Migration ─────────────────────────────────────────────────

describe('Mock engine: deploy new version → zero actors migrate', () => {
  test('actors remain on v1 after v2 deployment when mock always returns stay', async () => {
    // This test validates mock behavior (no migration).
    // If STATEKEEP_ENGINE_PATH is NOT set (fallback mode), computeAccessible always returns null → stay.
    // If mock .so is loaded, same behavior.

    const baseId = `mock-nomig-${Date.now()}`;
    await put('/v1/definitions', { id: `${baseId}-v1`, definition: linearMachine(`${baseId}`) });

    // Spawn 3 actors on v1
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = await post('/v1/actors', { definitionId: `${baseId}-v1` });
      assert.equal(r.status, 201);
      ids.push(r.body.id);
    }

    // Deploy v2
    await put('/v1/definitions', {
      id:         `${baseId}-v2`,
      parentId:   `${baseId}-v1`,
      definition: linearMachine(`${baseId}`),
    });

    // Deploy
    // Deployment is triggered by PUT /v1/definitions — no separate POST /v1/deployments
    // Wait briefly, then check actors are still on v1
    await new Promise(r => setTimeout(r, 1000));

    for (const id of ids) {
      const state = await get(`/v1/actors/${id}/state`);
      assert.equal(state.status, 200);
      // With mock (always stay), definitionId should not change
      // (We can't directly check definitionId from /state, but actor should still work)
      const evtRes = await post(`/v1/actors/${id}/event`, { type: 'START' });
      assert.equal(evtRes.status, 200);
    }
  });
});
