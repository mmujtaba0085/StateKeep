/**
 * test/e2e/cursor-pagination.spec.js
 * Stage 3: Cursor pagination tests for GET /v1/actors/:id/events.
 */

import { test, expect } from '@playwright/test';

const API_KEY = process.env.STATEKEEP_API_KEY;
const hdr     = () => ({ 'X-API-Key': API_KEY, 'Content-Type': 'application/json' });

test('cursor pagination: second page contains no overlap with first page', async ({ request }) => {
  const ts    = Date.now();
  const defId = `cursor-${ts}`;
  const def   = { id: 'cur', initial: 'a',
    states: { a: { on: { X: 'b' } }, b: { on: { X: 'c' } }, c: { on: { X: 'd' } }, d: { on: { X: 'e' } }, e: { type: 'final' } } };

  await request.put('/v1/definitions', { data: { id: defId, definition: def }, headers: hdr() });
  const actor = await (await request.post('/v1/actors', { data: { definitionId: defId }, headers: hdr() })).json();

  // Send 4 events (SPAWN + X,X,X,X = 5 total events)
  for (let i = 0; i < 4; i++) {
    await request.post(`/v1/actors/${actor.id}/event`, { data: { type: 'X' }, headers: hdr() });
  }

  // Fetch page 1 — limit 3
  const p1 = await (await request.get(
    `/v1/actors/${actor.id}/events?limit=3`, { headers: hdr() })).json();
  expect(p1.hasMore).toBe(true);
  expect(p1.events.length).toBe(3);
  expect(p1.nextCursor).not.toBeNull();

  // Fetch page 2 — using cursor from page 1
  const p2 = await (await request.get(
    `/v1/actors/${actor.id}/events?limit=3&after=${p1.nextCursor}`, { headers: hdr() })).json();
  expect(p2.events.length).toBeGreaterThan(0);

  // No overlap
  const ids1 = new Set(p1.events.map(e => e.id));
  for (const e of p2.events) {
    expect(ids1.has(e.id)).toBe(false);
  }

  // All events in ascending order
  const allIds = [...p1.events, ...p2.events].map(e => e.id);
  const sorted = [...allIds].sort((a, b) => a - b);
  expect(allIds).toEqual(sorted);
});

test('cursor pagination: hasMore false when events fit in one page', async ({ request }) => {
  const ts    = Date.now();
  const defId = `cursor2-${ts}`;
  const def   = { id: 'cur2', initial: 'a', states: { a: { on: { X: 'b' } }, b: { type: 'final' } } };

  await request.put('/v1/definitions', { data: { id: defId, definition: def }, headers: hdr() });
  const actor = await (await request.post('/v1/actors', { data: { definitionId: defId }, headers: hdr() })).json();
  await request.post(`/v1/actors/${actor.id}/event`, { data: { type: 'X' }, headers: hdr() });

  const r = await (await request.get(
    `/v1/actors/${actor.id}/events?limit=50`, { headers: hdr() })).json();
  expect(r.hasMore).toBe(false);
  expect(r.nextCursor).toBeNull();
});
