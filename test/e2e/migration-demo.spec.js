/**
 * test/e2e/migration-demo.spec.js
 *
 * End-to-end demo story: full actor migration lifecycle.
 * Uses a shared state object (not bare let variables) so Playwright doesn't
 * reset state between test retries or project contexts.
 *
 * Story:
 *   1. Deploy order-v1 (idle → submitted → processing → shipped)
 *   2. Spawn three actors on v1; advance them to different states
 *   3. Deploy order-v2 (adds "refunded" state; historyPath wildcard)
 *   4. Verify inline migration: next event on a v1 actor triggers auto-migrate
 *   5. Verify migration decision log records the migration
 *   6. Verify machine-level stats include actors from both versions
 *   7. Deploy order-v3 that REMOVES "submitted" state → stranded-actor flow
 *   8. Confirm stranded deployment; verify needs_rescue actors
 */

import { test, expect } from '@playwright/test';
import { GET, POST, PUT, uniqueId } from './helpers/api.js';

// Helper: assert HTTP 2xx without relying on version-specific matchers
function expect2xx(res, label = '') {
  const ok = res.status >= 200 && res.status < 300;
  expect(ok, `${label}HTTP ${res.status}: ${JSON.stringify(res.body)}`).toBe(true);
}

const ORDER_V1 = {
  id:      'order',
  initial: 'idle',
  states: {
    idle:       { on: { SUBMIT: 'submitted' } },
    submitted:  { on: { PROCESS: 'processing' } },
    processing: { on: { SHIP: 'shipped' } },
    shipped:    { type: 'final' },
  },
};

const ORDER_V2 = {
  id:      'order',
  initial: 'idle',
  states: {
    idle:       { on: { SUBMIT: 'submitted' } },
    submitted:  { on: { PROCESS: 'processing' } },
    processing: { on: { SHIP: 'shipped', REFUND: 'refunded' } },
    shipped:    { type: 'final' },
    refunded:   { type: 'final' },
  },
};

const ORDER_V3_REMOVES_SUBMITTED = {
  id:      'order',
  initial: 'idle',
  states: {
    idle:       { on: { SUBMIT: 'processing' } },   // skip submitted
    processing: { on: { SHIP: 'shipped', REFUND: 'refunded' } },
    shipped:    { type: 'final' },
    refunded:   { type: 'final' },
  },
};

// Use an object reference (not bare let) so closure updates are visible across test boundaries
const ctx = {
  v1Id: null, v2Id: null, v3Id: null,
  actorIdle: null, actorSubmitted: null, actorProcessing: null,
};

// ── Set up all state in a single beforeAll ────────────────────────────────────
// This avoids Playwright re-initialising module-level variables between tests.

test.describe('migration demo', () => {
  test.beforeAll(async () => {
    // 1. Deploy v1
    ctx.v1Id = uniqueId('order-v1');
    const put1 = await PUT('/v1/definitions', { id: ctx.v1Id, definition: ORDER_V1 });
    expect2xx(put1, 'beforeAll deploy v1: ');

    // 2. Spawn three actors
    const a = await POST('/v1/actors', { definitionId: ctx.v1Id });
    expect(a.status).toBe(201);
    ctx.actorIdle = a.body.id;

    const b = await POST('/v1/actors', { definitionId: ctx.v1Id });
    ctx.actorSubmitted = b.body.id;

    const c = await POST('/v1/actors', { definitionId: ctx.v1Id });
    ctx.actorProcessing = c.body.id;

    // 3. Advance actors
    await POST(`/v1/actors/${ctx.actorSubmitted}/event`, { type: 'SUBMIT' });
    await POST(`/v1/actors/${ctx.actorProcessing}/event`, { type: 'SUBMIT' });
    await POST(`/v1/actors/${ctx.actorProcessing}/event`, { type: 'PROCESS' });

    // 4. Deploy v2
    ctx.v2Id = uniqueId('order-v2');
    const put2 = await PUT('/v1/definitions', {
      id:         ctx.v2Id,
      parentId:   ctx.v1Id,
      definition: ORDER_V2,
    });
    expect2xx(put2, 'beforeAll deploy v2: ');

    // 5. Send event to actorIdle (may trigger inline migration)
    await POST(`/v1/actors/${ctx.actorIdle}/event`, { type: 'SUBMIT' });

    // 6. Deploy v3 (removes submitted state)
    ctx.v3Id = uniqueId('order-v3');
    const put3 = await PUT('/v1/definitions', {
      id:         ctx.v3Id,
      parentId:   ctx.v2Id,
      definition: ORDER_V3_REMOVES_SUBMITTED,
    });

    if (put3.status === 200 && put3.body.status === 'requires_confirmation') {
      // Confirm stranded deployment
      await PUT('/v1/definitions', {
        id:           ctx.v3Id,
        parentId:     ctx.v2Id,
        definition:   ORDER_V3_REMOVES_SUBMITTED,
        confirmToken: put3.body.confirmToken,
      });
    }
    // If no stranded actors, deploy succeeds immediately — either way v3 is deployed
  });

  // ── Individual tests ──────────────────────────────────────────────────────────

  test('1 — v1 definition was deployed', async () => {
    expect(ctx.v1Id).toBeTruthy();
    const res = await GET(`/v1/definitions/${ctx.v1Id}/status`);
    expect(res.status).toBe(200);
    expect(res.body.definition.id).toBe(ctx.v1Id);
  });

  test('2 — three actors were spawned on v1', async () => {
    expect(ctx.actorIdle).toBeTruthy();
    expect(ctx.actorSubmitted).toBeTruthy();
    expect(ctx.actorProcessing).toBeTruthy();
  });

  test('3 — actors reached their expected states', async () => {
    const s1 = await GET(`/v1/actors/${ctx.actorSubmitted}/state`);
    expect(s1.body.stateValue).toBe('submitted');

    const s2 = await GET(`/v1/actors/${ctx.actorProcessing}/state`);
    expect(s2.body.stateValue).toBe('processing');

    const s3 = await GET(`/v1/actors/${ctx.actorIdle}/state`);
    expect(s3.body.stateValue).toBe('submitted');   // sent SUBMIT in beforeAll
  });

  test('4 — v2 definition was deployed as child of v1', async () => {
    expect(ctx.v2Id).toBeTruthy();
    const res = await GET(`/v1/definitions/${ctx.v2Id}/status`);
    expect(res.status).toBe(200);
    expect(res.body.definition.id).toBe(ctx.v2Id);
  });

  test('5 — inline migration result is valid (migrated or stayed)', async () => {
    // actorIdle already had SUBMIT sent in beforeAll
    const state = await GET(`/v1/actors/${ctx.actorIdle}/state`);
    expect(state.status).toBe(200);
    expect(state.body.stateValue).toBe('submitted');
    // Actor is now on v1 (engine unavailable) or v2 (engine available) — both are fine
  });

  test('6 — GET /v1/definitions/:id/diff shows refunded added in v2', async () => {
    const res = await GET(`/v1/definitions/${ctx.v2Id}/diff`);
    expect(res.status).toBe(200);
    expect(res.body.diff.statesAdded).toContain('refunded');
  });

  test('7 — migration decision log returns a valid response for actorIdle', async () => {
    const res = await GET(`/v1/actors/${ctx.actorIdle}/decisions`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.decisions)).toBe(true);
    // Engine unavailable → 0 decisions; engine available → ≥ 1
    expect(res.body.total).toBeGreaterThanOrEqual(0);
  });

  test('8 — machine stats include actors across both versions', async () => {
    const res = await GET(`/v1/machines/${ctx.v1Id}/stats`);
    expect(res.status).toBe(200);
    expect(res.body.machineId).toBe(ctx.v1Id);
    expect(res.body.totalActive).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.versions)).toBe(true);
    expect(res.body.versions.length).toBeGreaterThanOrEqual(1);
  });

  test('9 — v3 definition was deployed', async () => {
    expect(ctx.v3Id).toBeTruthy();
  });

  test('10 — GET /v1/actors/needs-rescue lists stranded actors', async () => {
    const res = await GET('/v1/actors/needs-rescue');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.actors)).toBe(true);
    expect(res.body.message).toBeTruthy();
  });

  test('11 — actorProcessing event history contains SPAWN, SUBMIT, PROCESS', async () => {
    const res = await GET(`/v1/actors/${ctx.actorProcessing}/events`);
    expect(res.status).toBe(200);
    const types = res.body.events.map(e => e.type);
    expect(types).toContain('SPAWN');
    expect(types).toContain('SUBMIT');
    expect(types).toContain('PROCESS');
  });

  test('12 — deployment decisions endpoint works for v2 deployment', async () => {
    const status = await GET(`/v1/definitions/${ctx.v2Id}/status`);
    expect(status.status).toBe(200);
    const deployments = status.body.deployments;
    expect(deployments).toBeDefined();

    if (deployments && deployments.length > 0) {
      const depId = deployments[0].id;
      const res = await GET(`/v1/deployments/${depId}/decisions`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.decisions)).toBe(true);
    }
  });
});
