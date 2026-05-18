/**
 * test/e2e/actors.spec.js
 * E2E tests for actor lifecycle: spawn, send event, state query, terminate.
 */

import { test, expect } from '@playwright/test';
import { GET, POST, PUT, DELETE, PATCH, SIMPLE_MACHINE, SIMPLE_MACHINE_V2, uniqueId } from './helpers/api.js';

let defId;

test.beforeAll(async () => {
  defId = uniqueId('actor-e2e-def');
  const res = await PUT('/v1/definitions', { id: defId, definition: SIMPLE_MACHINE });
  const ok = res.status >= 200 && res.status < 300;
  expect(ok, `Setup failed: HTTP ${res.status} ${JSON.stringify(res.body)}`).toBe(true);
});

test('spawn actor returns initial state', async () => {
  const res = await POST('/v1/actors', { definitionId: defId });
  expect(res.status).toBe(201);
  expect(res.body.id).toBeTruthy();
  expect(res.body.stateValue).toBe('idle');
});

test('send event transitions state', async () => {
  const spawn = await POST('/v1/actors', { definitionId: defId });
  const id    = spawn.body.id;

  const res = await POST(`/v1/actors/${id}/event`, { type: 'START' });
  expect(res.status).toBe(200);
  expect(res.body.stateValue).toBe('running');
  expect(res.body.done).toBe(false);
});

test('sending event to final state sets done=true', async () => {
  const spawn = await POST('/v1/actors', { definitionId: defId });
  const id    = spawn.body.id;

  await POST(`/v1/actors/${id}/event`, { type: 'START' });
  const res = await POST(`/v1/actors/${id}/event`, { type: 'STOP' });
  expect(res.status).toBe(200);
  expect(res.body.stateValue).toBe('done');
  expect(res.body.done).toBe(true);
});

test('GET /v1/actors/:id/state returns current state', async () => {
  const spawn = await POST('/v1/actors', { definitionId: defId });
  const id    = spawn.body.id;

  await POST(`/v1/actors/${id}/event`, { type: 'START' });
  const res = await GET(`/v1/actors/${id}/state`);
  expect(res.status).toBe(200);
  expect(res.body.stateValue).toBe('running');
});

test('GET /v1/actors/:id/events returns event history', async () => {
  const spawn = await POST('/v1/actors', { definitionId: defId });
  const id    = spawn.body.id;

  await POST(`/v1/actors/${id}/event`, { type: 'START' });
  const res = await GET(`/v1/actors/${id}/events`);
  expect(res.status).toBe(200);
  expect(res.body.events.length).toBeGreaterThanOrEqual(1);
  expect(res.body.events.some(e => e.type === 'SPAWN')).toBe(true);
});

test('DELETE /v1/actors/:id terminates actor', async () => {
  const spawn = await POST('/v1/actors', { definitionId: defId });
  const id    = spawn.body.id;

  const del = await DELETE(`/v1/actors/${id}`);
  expect(del.status).toBe(200);
  expect(typeof del.body.cancelled).toBe('number');

  // Subsequent event should fail
  const ev = await POST(`/v1/actors/${id}/event`, { type: 'START' });
  expect(ev.status).toBeGreaterThanOrEqual(400);
});

test('unknown event is rejected gracefully', async () => {
  const spawn = await POST('/v1/actors', { definitionId: defId });
  const id    = spawn.body.id;

  const res = await POST(`/v1/actors/${id}/event`, { type: 'NONEXISTENT_EVENT' });
  // Should not crash the server — state unchanged
  const state = await GET(`/v1/actors/${id}/state`);
  expect(state.body.stateValue).toBe('idle');
});

test('GET /v1/actors/:id/decisions returns decision log', async () => {
  const spawn = await POST('/v1/actors', { definitionId: defId });
  const id    = spawn.body.id;

  await POST(`/v1/actors/${id}/event`, { type: 'START' });

  const res = await GET(`/v1/actors/${id}/decisions`);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.decisions)).toBe(true);
});

test('GET /v1/actors returns actor list', async () => {
  const res = await GET('/v1/actors');
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.actors)).toBe(true);
});

// ── Bulk spawn ────────────────────────────────────────────────────────────────

test('POST /v1/actors/bulk spawns multiple actors and returns 207', async () => {
  const res = await POST('/v1/actors/bulk', {
    actors: [
      { definitionId: defId },
      { definitionId: defId, initialContext: { tag: 'b' } },
      { definitionId: defId },
    ],
  });
  expect(res.status).toBe(207);
  expect(Array.isArray(res.body.created)).toBe(true);
  expect(res.body.created).toHaveLength(3);
  expect(Array.isArray(res.body.failed)).toBe(true);
  expect(res.body.failed).toHaveLength(0);
  expect(res.body.total).toBe(3);
  for (const actor of res.body.created) {
    expect(actor.id).toBeTruthy();
    expect(actor.stateValue).toBe('idle');
  }
});

test('POST /v1/actors/bulk returns partial success when one definitionId is invalid', async () => {
  const res = await POST('/v1/actors/bulk', {
    actors: [
      { definitionId: defId },
      { definitionId: 'nonexistent-def-bulk-test-' + Date.now() },
    ],
  });
  expect(res.status).toBe(207);
  expect(res.body.created).toHaveLength(1);
  expect(res.body.failed).toHaveLength(1);
  expect(res.body.failed[0].index).toBe(1);
  expect(res.body.failed[0].error).toBeTruthy();
});

// ── needs_rescue → active reset ───────────────────────────────────────────────

test('PATCH /v1/actors/:id resets needs_rescue status to active', async () => {
  // Deploy a v1, spawn an actor, advance it, then deploy v2 that removes the state
  const v1Id = uniqueId('patch-rescue-v1');
  const v2Id = uniqueId('patch-rescue-v2');

  const V1 = {
    initial: 'idle',
    states: {
      idle:    { on: { GO: 'working' } },
      working: { on: { DONE: 'finished' } },
      finished: { type: 'final' },
    },
  };
  await PUT('/v1/definitions', { id: v1Id, definition: V1 });

  const spawn = await POST('/v1/actors', { definitionId: v1Id });
  const actorId = spawn.body.id;
  await POST(`/v1/actors/${actorId}/event`, { type: 'GO' });

  // v2 removes 'working', stranding the actor
  const V2 = { initial: 'idle', states: { idle: { on: { DONE: 'finished' } }, finished: { type: 'final' } } };
  const d1 = await PUT('/v1/definitions', { id: v2Id, parentId: v1Id, definition: V2 });
  if (d1.status === 200 && d1.body.status === 'requires_confirmation') {
    await PUT('/v1/definitions', { id: v2Id, parentId: v1Id, definition: V2, confirmToken: d1.body.confirmToken });
  }

  const stranded = await GET(`/v1/actors/${actorId}/state`);
  expect(stranded.body.status).toBe('needs_rescue');

  // PATCH resets to active
  const patch = await PATCH(`/v1/actors/${actorId}`, { status: 'active' });
  expect(patch.status).toBe(200);
  expect(patch.body.status).toBe('active');

  // Invalid transitions rejected
  const badPatch = await PATCH(`/v1/actors/${actorId}`, { status: 'terminated' });
  expect(badPatch.status).toBe(400);
});
