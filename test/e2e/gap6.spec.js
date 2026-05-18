/**
 * test/e2e/gap6.spec.js
 *
 * State-position-on-migration tests.
 *
 * Verifies resolveLandingState behaviour end-to-end:
 *  1. Actor in a same-name state lands there (not machine.initial)
 *  2. Actor lands in stateMapping target when the old state is removed
 *  3. Actor with no mapping and removed state becomes needs_rescue
 *  4. Context is preserved through migration
 *  5. historyFingerprint is preserved (events not wiped)
 *  6. historyPath deployment: affected_actors counts only fingerprint-matching actors,
 *     and changepoints are persisted (DB-seeded registry enables worker re-check)
 */

import { test, expect } from '@playwright/test';
import { GET, POST, PUT, uniqueId } from './helpers/api.js';

function expect2xx(res, label = '') {
  const ok = res.status >= 200 && res.status < 300;
  expect(ok, `${label}HTTP ${res.status}: ${JSON.stringify(res.body)}`).toBe(true);
}

// Base v1 machine: idle → working → (paused | done)
// Initial state is 'idle'. Tests move actors to 'working' first.
const V1 = {
  initial: 'idle',
  states: {
    idle:    { on: { WORK: 'working' } },
    working: { on: { PAUSE: 'paused', FINISH: 'done' } },
    paused:  { on: { RESUME: 'working' } },
    done:    { type: 'final' },
  },
};

test.describe('gap6 — state position on migration', () => {

  // ── Test 1: same-name state ──────────────────────────────────────────────────

  test('actor in same-name state migrates to that state, not machine.initial', async () => {
    const v1Id = uniqueId('g6-same-v1');
    const v2Id = uniqueId('g6-same-v2');

    expect2xx(await PUT('/v1/definitions', { id: v1Id, definition: V1 }), 'deploy v1: ');

    const spawnRes = await POST('/v1/actors', { definitionId: v1Id });
    expect(spawnRes.status).toBe(201);
    const actorId = spawnRes.body.id;

    // Advance actor to 'working' (not the initial 'idle')
    expect2xx(await POST(`/v1/actors/${actorId}/event`, { type: 'WORK' }), 'WORK: ');

    // v2 keeps all states, adds 'cancelled'
    const V2 = {
      initial: 'idle',
      states: {
        idle:      { on: { WORK: 'working' } },
        working:   { on: { PAUSE: 'paused', FINISH: 'done', CANCEL: 'cancelled' } },
        paused:    { on: { RESUME: 'working' } },
        done:      { type: 'final' },
        cancelled: { type: 'final' },
      },
    };
    expect2xx(await PUT('/v1/definitions', { id: v2Id, parentId: v1Id, definition: V2 }), 'deploy v2: ');

    // PAUSE is valid from 'working' but not from 'idle'.
    // If migration correctly lands in 'working', actor goes to 'paused'.
    // If it wrongly resets to 'idle', PAUSE is ignored and state stays 'idle'.
    await POST(`/v1/actors/${actorId}/event`, { type: 'PAUSE' });

    const state = await GET(`/v1/actors/${actorId}/state`);
    expect(state.status).toBe(200);
    expect(state.body.stateValue).toBe('paused');
  });

  // ── Test 2: stateMapping ─────────────────────────────────────────────────────

  test('actor with stateMapping migrates to the mapped state', async () => {
    const v1Id = uniqueId('g6-map-v1');
    const v2Id = uniqueId('g6-map-v2');

    expect2xx(await PUT('/v1/definitions', { id: v1Id, definition: V1 }), 'deploy v1: ');

    const spawnRes = await POST('/v1/actors', { definitionId: v1Id });
    const actorId  = spawnRes.body.id;
    expect2xx(await POST(`/v1/actors/${actorId}/event`, { type: 'WORK' }), 'WORK: ');

    // v2: 'working' renamed to 'active'; stateMapping maps old→new
    const V2 = {
      initial: 'idle',
      states: {
        idle:   { on: { WORK: 'active' } },
        active: { on: { PAUSE: 'paused', FINISH: 'done' } },
        paused: { on: { RESUME: 'active' } },
        done:   { type: 'final' },
      },
    };
    expect2xx(await PUT('/v1/definitions', {
      id:           v2Id,
      parentId:     v1Id,
      definition:   V2,
      stateMapping: { working: 'active' },
    }), 'deploy v2: ');

    // PAUSE is valid from 'active' but not from 'idle'.
    await POST(`/v1/actors/${actorId}/event`, { type: 'PAUSE' });

    const state = await GET(`/v1/actors/${actorId}/state`);
    expect(state.status).toBe(200);
    expect(state.body.stateValue).toBe('paused');
  });

  // ── Test 3: needs_rescue via stranded-actor confirmation flow ────────────────

  test('actor in removed state with no mapping becomes needs_rescue', async () => {
    const v1Id = uniqueId('g6-rescue-v1');
    const v2Id = uniqueId('g6-rescue-v2');

    expect2xx(await PUT('/v1/definitions', { id: v1Id, definition: V1 }), 'deploy v1: ');

    const spawnRes = await POST('/v1/actors', { definitionId: v1Id });
    const actorId  = spawnRes.body.id;
    expect2xx(await POST(`/v1/actors/${actorId}/event`, { type: 'WORK' }), 'WORK: ');

    // v2 removes 'working', no stateMapping — actor in 'working' is stranded
    const V2 = {
      initial: 'idle',
      states: {
        idle: { on: { FINISH: 'done' } },
        done: { type: 'final' },
      },
    };

    const deploy1 = await PUT('/v1/definitions', { id: v2Id, parentId: v1Id, definition: V2 });

    if (deploy1.status === 200 && deploy1.body.status === 'requires_confirmation') {
      // Confirm: this triggers bulkTagNeedsRescue for stranded actors
      const deploy2 = await PUT('/v1/definitions', {
        id:           v2Id,
        parentId:     v1Id,
        definition:   V2,
        confirmToken: deploy1.body.confirmToken,
      });
      expect2xx(deploy2, 'confirm deploy v2: ');
    } else {
      // No stranded actors detected (actor may have been evicted) — pass
      expect2xx(deploy1, 'deploy v2: ');
    }

    const state = await GET(`/v1/actors/${actorId}/state`);
    expect(state.status).toBe(200);
    // Actor should be needs_rescue OR have been migrated to a state it can't reach
    // The definitive check: status is needs_rescue
    expect(state.body.status).toBe('needs_rescue');
  });

  // ── Test 4: context preserved ────────────────────────────────────────────────

  test('context is preserved through migration', async () => {
    const v1Id = uniqueId('g6-ctx-v1');
    const v2Id = uniqueId('g6-ctx-v2');

    expect2xx(await PUT('/v1/definitions', { id: v1Id, definition: V1 }), 'deploy v1: ');

    const spawnRes = await POST('/v1/actors', {
      definitionId:   v1Id,
      initialContext: { jobId: 'ctx-preserved-42', priority: 'high' },
    });
    const actorId = spawnRes.body.id;
    expect2xx(await POST(`/v1/actors/${actorId}/event`, { type: 'WORK' }), 'WORK: ');

    const V2 = { ...V1 };
    expect2xx(await PUT('/v1/definitions', { id: v2Id, parentId: v1Id, definition: V2 }), 'deploy v2: ');

    // Trigger migration via event
    await POST(`/v1/actors/${actorId}/event`, { type: 'PAUSE' });

    const state = await GET(`/v1/actors/${actorId}/state`);
    expect(state.status).toBe(200);
    expect(state.body.context?.jobId).toBe('ctx-preserved-42');
    expect(state.body.context?.priority).toBe('high');
  });

  // ── Test 6: historyPath filtering + changepoint persistence ─────────────────

  test('historyPath deployment only targets fingerprint-matching actors (affected_actors is filtered count)', async () => {
    // Requires APV engine for fingerprint-based filtering; skip in fallback mode
    const health = await GET('/v1/health');
    if (health.body?.engine !== 'real') {
      test.skip();
      return;
    }

    const v1Id = uniqueId('g6-fp-filter-v1');
    const v2Id = uniqueId('g6-fp-filter-v2');

    expect2xx(await PUT('/v1/definitions', { id: v1Id, definition: V1 }), 'deploy v1: ');

    // Spawn 4 actors: 2 advance to 'working' (path A), 2 stay at 'idle' (path B)
    const pathA = [];
    const pathB = [];
    for (let i = 0; i < 2; i++) {
      const r = await POST('/v1/actors', { definitionId: v1Id });
      expect(r.status).toBe(201);
      expect2xx(await POST(`/v1/actors/${r.body.id}/event`, { type: 'WORK' }), 'WORK: ');
      pathA.push(r.body.id);
    }
    for (let i = 0; i < 2; i++) {
      const r = await POST('/v1/actors', { definitionId: v1Id });
      expect(r.status).toBe(201);
      pathB.push(r.body.id);
    }

    // Deploy v2 with historyPath=['WORK'] — only path A actors are eligible
    const V2 = {
      initial: 'idle',
      states: {
        idle:    { on: { WORK: 'working' } },
        working: { on: { PAUSE: 'paused', FINISH: 'done' } },
        paused:  { on: { RESUME: 'working' } },
        done:    { type: 'final' },
        extra:   { type: 'final' },  // new state to force a distinct v2
      },
    };
    const deployRes = await PUT('/v1/definitions', {
      id:          v2Id,
      parentId:    v1Id,
      definition:  V2,
      historyPath: ['WORK'],
    });
    expect2xx(deployRes, 'deploy v2 with historyPath: ');
    expect(deployRes.status).toBe(201);

    // affected_actors must be 2 (path A only), not 4 (all actors)
    expect(deployRes.body.affectedActors).toBe(2);

    // Path A actor: receives next event on old def → inline migration to v2
    const pauseRes = await POST(`/v1/actors/${pathA[0]}/event`, { type: 'PAUSE' });
    expect2xx(pauseRes, 'PAUSE after migration: ');
    const stateA = await GET(`/v1/actors/${pathA[0]}/state`);
    expect(stateA.status).toBe(200);
    expect(stateA.body.definitionId).toBe(v2Id);

    // Path B actor: stays on v1 (idle state, no matching fingerprint)
    const stateB = await GET(`/v1/actors/${pathB[0]}/state`);
    expect(stateB.status).toBe(200);
    expect(stateB.body.definitionId).toBe(v1Id);

    // Deployment status: must show affected_actors=2 matching the deployment response
    const statusRes = await GET(`/v1/definitions/${v2Id}/status`);
    expect(statusRes.status).toBe(200);
    const dep = statusRes.body.deployments?.[0];
    expect(dep).toBeDefined();
    expect(dep.affected_actors).toBe(2);
  });

  // ── Test 5: historyFingerprint preserved ─────────────────────────────────────

  test('historyFingerprint is preserved — events are not wiped on migration', async () => {
    const v1Id = uniqueId('g6-fp-v1');
    const v2Id = uniqueId('g6-fp-v2');

    expect2xx(await PUT('/v1/definitions', { id: v1Id, definition: V1 }), 'deploy v1: ');

    const spawnRes = await POST('/v1/actors', { definitionId: v1Id });
    const actorId  = spawnRes.body.id;
    // Build history: SPAWN + WORK
    expect2xx(await POST(`/v1/actors/${actorId}/event`, { type: 'WORK' }), 'WORK: ');

    const V2 = { ...V1 };
    expect2xx(await PUT('/v1/definitions', { id: v2Id, parentId: v1Id, definition: V2 }), 'deploy v2: ');

    // Trigger migration + add one more event
    await POST(`/v1/actors/${actorId}/event`, { type: 'PAUSE' });

    // Events stored in DB must include pre-migration events
    const evRes = await GET(`/v1/actors/${actorId}/events`);
    expect(evRes.status).toBe(200);
    const events = evRes.body.events ?? evRes.body ?? [];
    // SPAWN + WORK + PAUSE = at least 2 stored events (SPAWN may be implicit)
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

});
