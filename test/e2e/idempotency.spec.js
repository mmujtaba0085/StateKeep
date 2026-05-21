/**
 * test/e2e/idempotency.spec.js
 * Stage 2: Idempotent event dispatch tests.
 */

import { test, expect } from '@playwright/test';
import { PUT, POST, GET, uniqueId } from './helpers/api.js';

const API_KEY = process.env.STATEKEEP_API_KEY;
const hdr     = () => ({ 'X-API-Key': API_KEY, 'Content-Type': 'application/json' });

test('idempotent event: same key returns current state without re-processing', async ({ request }) => {
  const ts    = Date.now();
  const defId = `idem-test-${ts}`;
  const def   = { id: 'idem', initial: 'idle',
    states: { idle: { on: { GO: 'working' } }, working: { on: { DONE: 'done' } }, done: { type: 'final' } } };

  await request.put('/v1/definitions', { data: { id: defId, definition: def }, headers: hdr() });
  const actor   = await (await request.post('/v1/actors', { data: { definitionId: defId }, headers: hdr() })).json();
  const actorId = actor.id;

  // First dispatch — should process
  const r1 = await request.post(`/v1/actors/${actorId}/event`,
    { data: { type: 'GO', idempotencyKey: 'go-001' }, headers: hdr() });
  expect(r1.ok()).toBeTruthy();
  const b1 = await r1.json();
  expect(b1.idempotent).toBeFalsy();

  // Second dispatch with same key — must NOT re-process
  const r2 = await request.post(`/v1/actors/${actorId}/event`,
    { data: { type: 'GO', idempotencyKey: 'go-001' }, headers: hdr() });
  expect(r2.ok()).toBeTruthy();
  const b2 = await r2.json();
  expect(b2.idempotent).toBe(true);

  // State is working (not double-transitioned to done)
  const state = await (await request.get(`/v1/actors/${actorId}/state`, { headers: hdr() })).json();
  expect(state.stateValue).toBe('working');

  // Only ONE 'GO' event in history
  const events = await (await request.get(`/v1/actors/${actorId}/events`, { headers: hdr() })).json();
  const goEvents = events.events.filter(e => e.type === 'GO');
  expect(goEvents.length).toBe(1);
});

test('same idempotency key on different actors both process independently', async ({ request }) => {
  const ts    = Date.now();
  const defId = `idem-xactor-${ts}`;
  const def   = { id: 'idem2', initial: 'idle',
    states: { idle: { on: { GO: 'done' } }, done: { type: 'final' } } };

  await request.put('/v1/definitions', { data: { id: defId, definition: def }, headers: hdr() });
  const a1 = await (await request.post('/v1/actors', { data: { definitionId: defId }, headers: hdr() })).json();
  const a2 = await (await request.post('/v1/actors', { data: { definitionId: defId }, headers: hdr() })).json();

  // Same key on different actors — both must process
  const r1 = await request.post(`/v1/actors/${a1.id}/event`,
    { data: { type: 'GO', idempotencyKey: 'shared-key' }, headers: hdr() });
  const r2 = await request.post(`/v1/actors/${a2.id}/event`,
    { data: { type: 'GO', idempotencyKey: 'shared-key' }, headers: hdr() });

  expect(r1.ok()).toBeTruthy();
  expect(r2.ok()).toBeTruthy();
  expect((await r1.json()).idempotent).toBeFalsy();
  expect((await r2.json()).idempotent).toBeFalsy();

  const s1 = await (await request.get(`/v1/actors/${a1.id}/state`, { headers: hdr() })).json();
  const s2 = await (await request.get(`/v1/actors/${a2.id}/state`, { headers: hdr() })).json();
  expect(s1.stateValue).toBe('done');
  expect(s2.stateValue).toBe('done');
});

test('event without idempotencyKey always processes (existing behaviour unchanged)', async ({ request }) => {
  const ts    = Date.now();
  const defId = `idem-none-${ts}`;
  const def   = { id: 'idem3', initial: 'a',
    states: { a: { on: { X: 'b' } }, b: { on: { X: 'c' } }, c: { type: 'final' } } };

  await request.put('/v1/definitions', { data: { id: defId, definition: def }, headers: hdr() });
  const actor = await (await request.post('/v1/actors', { data: { definitionId: defId }, headers: hdr() })).json();

  // Two X events without idempotency keys — both must process
  await request.post(`/v1/actors/${actor.id}/event`, { data: { type: 'X' }, headers: hdr() });
  await request.post(`/v1/actors/${actor.id}/event`, { data: { type: 'X' }, headers: hdr() });

  const state = await (await request.get(`/v1/actors/${actor.id}/state`, { headers: hdr() })).json();
  expect(state.stateValue).toBe('c');  // processed twice as expected
});
