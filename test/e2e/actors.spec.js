/**
 * test/e2e/actors.spec.js
 * E2E tests for actor lifecycle: spawn, send event, state query, terminate.
 */

import { test, expect } from '@playwright/test';
import { GET, POST, PUT, DELETE, SIMPLE_MACHINE, SIMPLE_MACHINE_V2, uniqueId } from './helpers/api.js';

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
