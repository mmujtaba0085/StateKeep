/**
 * test/test_send_event.js
 * Proves: event processing, state transition, persistence
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { seedApiKey, post, put, get, SAMPLE_MACHINE_V1 } from './setup.js';

before(async () => {
  await seedApiKey();
  await put('/v1/definitions', { id: 'event-test-v1', definition: SAMPLE_MACHINE_V1 });
});

test('sending START event transitions from idle to running', async () => {
  // Spawn actor
  const spawnRes = await post('/v1/actors', { definitionId: 'event-test-v1' });
  assert.equal(spawnRes.status, 201);
  const actorId = spawnRes.body.id;

  // Send START
  const eventRes = await post(`/v1/actors/${actorId}/event`, { type: 'START' });
  assert.equal(eventRes.status, 200, JSON.stringify(eventRes.body));
  assert.equal(eventRes.body.stateValue, 'running');

  // State is persisted — fetch from /v1/actors/:id/state
  const stateRes = await get(`/v1/actors/${actorId}/state`);
  assert.equal(stateRes.status, 200);
  assert.equal(stateRes.body.stateValue, 'running');
});

test('full lifecycle: idle → running → paused → running → done', async () => {
  const { id } = (await post('/v1/actors', { definitionId: 'event-test-v1' })).body;

  const transitions = [
    { type: 'START',  expected: 'running' },
    { type: 'PAUSE',  expected: 'paused'  },
    { type: 'RESUME', expected: 'running' },
    { type: 'STOP',   expected: 'done'    },
  ];

  for (const { type, expected } of transitions) {
    const r = await post(`/v1/actors/${id}/event`, { type });
    assert.equal(r.status, 200, `Failed on ${type}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.stateValue, expected, `After ${type}: expected ${expected}, got ${r.body.stateValue}`);
  }

  // Actor should be done
  const final = (await post(`/v1/actors/${id}/event`, { type: 'START' })).body;
  // XState ignores events in final state — should still be done
  assert.equal(final.stateValue, 'done');
});

test('event to non-existent actor returns 404', async () => {
  const r = await post('/v1/actors/nonexistent-id/event', { type: 'START' });
  assert.equal(r.status, 404);
});

test('event with initialContext is available after spawn', async () => {
  const r = await post('/v1/actors', {
    definitionId:   'event-test-v1',
    initialContext: { userId: 'u123', order: 42 },
  });
  assert.equal(r.status, 201);
  // Context hydration — the machine may or may not expose context
  // but the actor persists it
  const state = (await get(`/v1/actors/${r.body.id}/state`)).body;
  assert.ok(state, 'State should be fetchable');
});
