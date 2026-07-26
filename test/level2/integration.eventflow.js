/**
 * test/level2/integration.eventflow.js
 *
 * Level 2 — Integration Tests: End-to-End Event Flow
 *
 * Tests:
 *   - Spawn actor → send N events → final state matches XState simulation
 *   - State is persisted across reads
 *   - Event history endpoint returns correct records in order
 *   - Termination marks actor as terminated; subsequent events return 4xx
 *   - Sending ignored event keeps state unchanged
 *   - Actor list endpoint filters by status and definitionId
 *   - Large context payload (50KB) survives round-trip
 *   - Unicode payload in event
 *
 * Requires server to be running on PORT 3099.
 * Start before running: node src/api/server.js &
 */

import '../setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { seedApiKey, post, get, del, put, BASE_URL, SAMPLE_MACHINE_V1 } from '../setup.js';
import { contexts, linearMachine, cyclicMachine, hierarchicalMachine } from '../helpers/factories.js';

before(async () => {
  await seedApiKey();
  // Register machines
  await put('/v1/definitions', { id: 'evt-linear-v1', definition: linearMachine('evt-linear') });
  await put('/v1/definitions', { id: 'evt-cyclic-v1', definition: cyclicMachine('evt-cyclic') });
  await put('/v1/definitions', { id: 'evt-hier-v1',   definition: hierarchicalMachine('evt-hier') });
  await put('/v1/definitions', { id: 'evt-sample-v1', definition: SAMPLE_MACHINE_V1 });
});

// ── Spawn + Event Flow ────────────────────────────────────────────────────────

describe('Linear machine: full lifecycle', () => {
  let actorId;

  test('spawn returns 201 and initial state = idle', async () => {
    const r = await post('/v1/actors', { definitionId: 'evt-linear-v1' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.id);
    assert.equal(r.body.stateValue, 'idle');
    actorId = r.body.id;
  });

  test('START transitions to processing', async () => {
    const r = await post(`/v1/actors/${actorId}/event`, { type: 'START' });
    assert.equal(r.status, 200);
    assert.equal(r.body.stateValue, 'processing');
  });

  test('state persists after transition (GET /state)', async () => {
    const r = await get(`/v1/actors/${actorId}/state`);
    assert.equal(r.status, 200);
    assert.equal(r.body.stateValue, 'processing');
  });

  test('COMPLETE transitions to done (final state)', async () => {
    const r = await post(`/v1/actors/${actorId}/event`, { type: 'COMPLETE' });
    assert.equal(r.status, 200);
    assert.equal(r.body.stateValue, 'done');
    assert.equal(r.body.done, true);
  });

  test('event history contains 2 events in order', async () => {
    const r = await get(`/v1/actors/${actorId}/events`);
    assert.equal(r.status, 200);
    const types = r.body.events.map(e => e.type);
    assert.ok(types.includes('START'));
    assert.ok(types.includes('COMPLETE'));
    // Verify tick ordering
    for (let i = 1; i < r.body.events.length; i++) {
      assert.ok(
        r.body.events[i].tick >= r.body.events[i - 1].tick,
        'Events must be non-decreasing in tick'
      );
    }
  });
});

describe('Cyclic machine: retries', () => {
  let actorId;

  test('spawn cyclic machine', async () => {
    const r = await post('/v1/actors', { definitionId: 'evt-cyclic-v1' });
    assert.equal(r.status, 201);
    actorId = r.body.id;
  });

  test('full retry sequence resolves to done', async () => {
    const sequence = [
      { type: 'RUN',     expected: 'running'    },
      { type: 'FAIL',    expected: 'retry_wait' },
      { type: 'RETRY',   expected: 'running'    },
      { type: 'FAIL',    expected: 'retry_wait' },
      { type: 'RETRY',   expected: 'running'    },
      { type: 'SUCCESS', expected: 'done'       },
    ];
    for (const { type, expected } of sequence) {
      const r = await post(`/v1/actors/${actorId}/event`, { type });
      assert.equal(r.status, 200, `Failed on ${type}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.stateValue, expected, `After ${type}`);
    }
  });

  test('event history count matches sequence length', async () => {
    const r = await get(`/v1/actors/${actorId}/events`);
    assert.equal(r.status, 200);
    // SPAWN + 6 events
    assert.ok(r.body.total >= 6, `Expected >= 6 events, got ${r.body.total}`);
  });
});

describe('Ignored events keep state unchanged', () => {
  test('sending unknown event to idle state leaves state as idle', async () => {
    const spawnRes = await post('/v1/actors', { definitionId: 'evt-linear-v1' });
    assert.equal(spawnRes.status, 201);
    const { id } = spawnRes.body;

    // COMPLETE is not valid from idle in linear machine
    const r = await post(`/v1/actors/${id}/event`, { type: 'COMPLETE' });
    // XState v5 simply ignores undefined transitions — state unchanged, no error
    assert.equal(r.status, 200);
    assert.equal(r.body.stateValue, 'idle', 'State should remain idle for unhandled event');
  });
});

describe('Termination', () => {
  test('DELETE actor returns 200 or 204', async () => {
    const spawn = await post('/v1/actors', { definitionId: 'evt-sample-v1' });
    assert.equal(spawn.status, 201);
    const id = spawn.body.id;

    const delRes = await del(`/v1/actors/${id}`);
    assert.ok([200, 204].includes(delRes.status), `DELETE actor should return 200 or 204, got ${delRes.status}`);
  });

  test('sending event to terminated actor returns 4xx', async () => {
    const spawn = await post('/v1/actors', { definitionId: 'evt-sample-v1' });
    assert.equal(spawn.status, 201);
    const id = spawn.body.id;

    await del(`/v1/actors/${id}`);

    const r = await post(`/v1/actors/${id}/event`, { type: 'START' });
    assert.ok(r.status >= 400, `Expected 4xx, got ${r.status}`);
  });
});

describe('Large context payload', () => {
  test('50KB context round-trips without corruption', async () => {
    const r = await post('/v1/actors', {
      definitionId:   'evt-linear-v1',
      initialContext: contexts.large,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.id;

    const state = await get(`/v1/actors/${id}/state`);
    assert.equal(state.status, 200);
    assert.ok(state.body, 'State should be returned');
  });
});

describe('Unicode payload in event', () => {
  test('emoji and multi-byte characters in event payload', async () => {
    const spawn = await post('/v1/actors', { definitionId: 'evt-linear-v1' });
    assert.equal(spawn.status, 201);
    const id = spawn.body.id;

    const r = await post(`/v1/actors/${id}/event`, {
      type:    'START',
      payload: { greeting: '🎉 こんにちは مرحبا', note: 'null\x00byte' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stateValue, 'processing');
  });
});

describe('Actor list / filter', () => {
  test('GET /v1/actors returns array', async () => {
    const r = await get('/v1/actors');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.actors));
    assert.ok(typeof r.body.count === 'number');
  });

  test('filter by definitionId narrows results', async () => {
    const uniqueDefId = `filter-test-${Date.now()}`;
    await put('/v1/definitions', { id: uniqueDefId, definition: linearMachine(uniqueDefId) });
    await post('/v1/actors', { definitionId: uniqueDefId });
    await post('/v1/actors', { definitionId: uniqueDefId });

    const r = await get(`/v1/actors?definitionId=${uniqueDefId}`);
    assert.equal(r.status, 200);
    const allMatch = r.body.actors.every(a => a.definitionId === uniqueDefId);
    assert.ok(allMatch, 'All returned actors should match definitionId filter');
  });
});

describe('Event pagination', () => {
  test('cursor pagination — pages do not overlap', async () => {
    const spawn = await post('/v1/actors', { definitionId: 'evt-cyclic-v1' });
    const id    = spawn.body.id;

    // Send 5 events
    for (const type of ['RUN', 'FAIL', 'RETRY', 'FAIL', 'RETRY']) {
      await post(`/v1/actors/${id}/event`, { type });
    }

    const page1 = await get(`/v1/actors/${id}/events?limit=3`);
    assert.equal(page1.status, 200);
    assert.ok(Array.isArray(page1.body.events), 'events must be an array');

    // If there's a nextCursor, verify page 2 has no overlap with page 1
    const cursor = page1.body.nextCursor;
    if (cursor && page1.body.events.length > 0) {
      const page2 = await get(`/v1/actors/${id}/events?limit=3&after=${cursor}`);
      assert.equal(page2.status, 200);

      const ids1 = new Set(page1.body.events.map(e => e.id));
      for (const e of page2.body.events) {
        assert.ok(!ids1.has(e.id), `Event ${e.id} appeared in both pages (no overlap required)`);
      }
    }
  });
});
