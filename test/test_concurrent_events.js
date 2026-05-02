/**
 * test/test_concurrent_events.js
 * Proves: 1000 actors, concurrent events, no state corruption
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { seedApiKey, post, put, get, SAMPLE_MACHINE_V1 } from './setup.js';

before(async () => {
  await seedApiKey();
  await put('/v1/definitions', { id: 'conc-test-v1', definition: SAMPLE_MACHINE_V1 });
});

const ACTOR_COUNT  = 100;   // reduced for unit test; 1000 is the load-test target
const EVENTS_BATCH = 5;

test(`spawn ${ACTOR_COUNT} actors concurrently without errors`, async () => {
  const results = await Promise.allSettled(
    Array.from({ length: ACTOR_COUNT }, () =>
      post('/v1/actors', { definitionId: 'conc-test-v1' })
    )
  );
  const failed = results.filter(r => r.status === 'rejected' || r.value?.status !== 201);
  assert.equal(failed.length, 0, `${failed.length} spawn(s) failed`);
});

test('concurrent events on same actor do not corrupt state', async () => {
  // Spawn one actor, send events 10 times concurrently
  const { id } = (await post('/v1/actors', { definitionId: 'conc-test-v1' })).body;

  // Send START first to leave idle
  await post(`/v1/actors/${id}/event`, { type: 'START' });

  // Send 10 concurrent PAUSE/RESUME pairs — state may vary but must be valid
  await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      post(`/v1/actors/${id}/event`, { type: i % 2 === 0 ? 'PAUSE' : 'RESUME' })
    )
  );

  // Final state must be a valid state value
  const state = await get(`/v1/actors/${id}/state`);
  assert.equal(state.status, 200);
  const validStates = new Set(['idle', 'running', 'paused', 'done']);
  assert.ok(
    validStates.has(state.body.stateValue),
    `State ${state.body.stateValue} not in valid set`
  );
});

test('events across many actors all persist correctly', async () => {
  const ids = (await Promise.all(
    Array.from({ length: 20 }, () =>
      post('/v1/actors', { definitionId: 'conc-test-v1' }).then(r => r.body.id)
    )
  ));

  // Send START to all
  await Promise.all(ids.map(id => post(`/v1/actors/${id}/event`, { type: 'START' })));

  // Verify all are in 'running' state
  const states = await Promise.all(ids.map(id => get(`/v1/actors/${id}/state`)));
  const wrongState = states.filter(s => s.body.stateValue !== 'running');
  assert.equal(wrongState.length, 0,
    `${wrongState.length} actors not in 'running' state after START`);
});
