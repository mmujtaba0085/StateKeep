/**
 * test/statechart/sc4.migration.js
 *
 * MIGRATION SCENARIO TESTS
 *
 * Exercises the full statechart versioning lifecycle:
 *   v1 definition → actors spawn → v2 deployed → migration evaluated
 *
 * Three migration pairs from machines.js are tested:
 *   MIGRATE_A: Additive (v2 adds states) — safe migration
 *   MIGRATE_B: Renaming (v2 renames states) — BREAKING migration
 *   MIGRATE_C: Subtractive (v2 removes states/transitions) — BREAKING migration
 *
 * Also exercises the diff endpoint to verify the platform's own diff
 * computation against expected results.
 *
 * Run: node --test test/statechart/sc4.migration.js
 */

import '../setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { seedApiKey, post, get, put } from '../setup.js';
import {
  MIGRATE_A_V1, MIGRATE_A_V2,
  MIGRATE_B_V1, MIGRATE_B_V2,
  MIGRATE_C_V1, MIGRATE_C_V2,
  VALID_LINEAR,
} from './machines.js';

before(async () => { await seedApiKey(); });

async function deploy(id, def, parentId) {
  const body = { id, definition: def };
  if (parentId) body.parentId = parentId;
  return put('/v1/definitions', body);
}
async function deployForce(id, def, parentId) {
  const body = { id, definition: def };
  if (parentId) body.parentId = parentId;
  let r = await put('/v1/definitions', body);
  if (r.status === 200 && r.body?.status === 'requires_confirmation' && r.body?.confirmToken) {
    r = await put('/v1/definitions', { ...body, confirmToken: r.body.confirmToken });
  }
  return r;
}
async function spawn(definitionId, ctx = {}) {
  return post('/v1/actors', { definitionId, initialContext: ctx });
}
async function send(id, type) { return post(`/v1/actors/${id}/event`, { type }); }
async function state(id)      { return get(`/v1/actors/${id}/state`); }
async function diff(id)       { return get(`/v1/definitions/${id}/diff`); }
async function defStatus(id)  { return get(`/v1/definitions/${id}/status`); }

// ─────────────────────────────────────────────────────────────────────────────
// A: Additive migration — v2 adds states (backward-compatible)
// ─────────────────────────────────────────────────────────────────────────────

describe('SC4-A: Additive migration — v2 adds "triaged" and "escalated" states', () => {
  const ts   = Date.now();
  const v1Id = `ticket-v1-${ts}`;
  const v2Id = `ticket-v2-${ts}`;
  let actorIds = [];

  before(async () => {
    // Deploy v1
    const r = await deploy(v1Id, MIGRATE_A_V1);
    assert.ok([200, 201].includes(r.status), `v1 deploy: ${JSON.stringify(r.body)}`);

    // Spawn 6 actors in different states
    const { id: a1 } = (await spawn(v1Id)).body;
    const { id: a2 } = (await spawn(v1Id)).body;
    const { id: a3 } = (await spawn(v1Id)).body;
    const { id: a4 } = (await spawn(v1Id)).body;
    const { id: a5 } = (await spawn(v1Id)).body;
    const { id: a6 } = (await spawn(v1Id)).body;

    // Put them in varied states
    await send(a2, 'ASSIGN');                  // → assigned
    await send(a3, 'ASSIGN'); await send(a3, 'UNASSIGN'); // → open again
    await send(a4, 'CLOSE');                   // → closed (final)
    await send(a5, 'ASSIGN'); await send(a5, 'RESOLVE');  // → resolved (final)
    // a6 stays in open, a1 stays in open

    actorIds = [a1, a2, a3, a4, a5, a6];
  });

  test('v1 actors are in expected states before migration', async () => {
    const states = await Promise.all(actorIds.map(id => state(id)));
    const vals   = states.map(r => r.body.stateValue);
    console.log(`  Pre-migration states: ${vals.join(', ')}`);
    assert.equal(vals[1], 'assigned', 'a2 should be assigned');
    assert.equal(vals[3], 'closed',   'a4 should be closed');
    assert.equal(vals[4], 'resolved', 'a5 should be resolved');
  });

  test('deploy v2 (additive) succeeds', async () => {
    const r = await deploy(v2Id, MIGRATE_A_V2, v1Id);
    assert.ok([200, 201].includes(r.status), `v2 deploy: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.parentId, v1Id);
  });

  test('diff endpoint shows correct additions', async () => {
    const r = await diff(v2Id);
    assert.equal(r.status, 200);
    const d = r.body.diff;

    // v2 adds 'triaged' and 'escalated'
    assert.ok(d.statesAdded.includes('triaged'),   `triaged missing from added: ${JSON.stringify(d.statesAdded)}`);
    assert.ok(d.statesAdded.includes('escalated'), `escalated missing from added: ${JSON.stringify(d.statesAdded)}`);
    // Nothing removed
    assert.equal(d.statesRemoved.length, 0, `Unexpected removals: ${JSON.stringify(d.statesRemoved)}`);
    console.log(`  Diff: added=${d.statesAdded.join(',')} removed=${d.statesRemoved.join(',')}`);
  });

  test('all v1 actors remain accessible after v2 deployment', async () => {
    // Give migration worker time to process
    await new Promise(r => setTimeout(r, 1500));
    for (const id of actorIds) {
      const r = await state(id);
      assert.ok([200].includes(r.status), `Actor ${id} inaccessible: ${r.status}`);
    }
  });

  test('v1 actors can still send events after v2 deployment', async () => {
    // Actor in 'open' state should still be able to transition
    const openActor = actorIds[0]; // a1 is in open
    const r = await send(openActor, 'ASSIGN');
    assert.equal(r.status, 200);
    // If migrated to v2: can also use TRIAGE (new) and ESCALATE (new)
    // If still on v1: ASSIGN still works
    assert.ok(['assigned', 'open'].includes(r.body.stateValue),
      `Unexpected state after ASSIGN: ${r.body.stateValue}`);
  });

  test('v2 directly spawned actors can use new TRIAGE state', async () => {
    const { id } = (await spawn(v2Id)).body;
    const r = await send(id, 'TRIAGE');
    assert.equal(r.status, 200);
    assert.equal(r.body.stateValue, 'triaged', 'v2 actor should reach triaged');

    const r2 = await send(id, 'ASSIGN');
    assert.equal(r2.body.stateValue, 'assigned');

    const r3 = await send(id, 'ESCALATE');
    assert.equal(r3.body.stateValue, 'escalated');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B: Breaking migration — v2 RENAMES states
// ─────────────────────────────────────────────────────────────────────────────

describe('SC4-B: Breaking migration — v2 renames "active"→"paying", "suspended"→"paused"', () => {
  const ts   = Date.now();
  const v1Id = `sub-v1-${ts}`;
  const v2Id = `sub-v2-${ts}`;
  let activeActorId, suspendedActorId, trialActorId;

  before(async () => {
    await deploy(v1Id, MIGRATE_B_V1);

    const { id: a } = (await spawn(v1Id)).body;
    const { id: b } = (await spawn(v1Id)).body;
    const { id: c } = (await spawn(v1Id)).body;

    // Put actors in states that v2 will rename
    await send(a, 'CONVERT');   // → active (v1) — this state is RENAMED in v2
    await send(b, 'CONVERT');
    await send(b, 'SUSPEND');   // → suspended (v1) — this state is RENAMED in v2
    // c stays in trial

    activeActorId    = a;
    suspendedActorId = b;
    trialActorId     = c;
  });

  test('diff shows states removed and added (rename appears as remove + add)', async () => {
    await deployForce(v2Id, MIGRATE_B_V2, v1Id);
    const r = await diff(v2Id);
    assert.equal(r.status, 200);
    const d = r.body.diff;

    // 'active' removed, 'paying' added; 'suspended' removed, 'paused' added
    assert.ok(d.statesRemoved.includes('active'),    `'active' should be in removed: ${JSON.stringify(d.statesRemoved)}`);
    assert.ok(d.statesRemoved.includes('suspended'), `'suspended' should be in removed`);
    assert.ok(d.statesAdded.includes('paying'),      `'paying' should be in added`);
    assert.ok(d.statesAdded.includes('paused'),      `'paused' should be in added`);
    console.log(`  Breaking diff: removed=[${d.statesRemoved}] added=[${d.statesAdded}]`);
  });

  test('[GAP] actor currently in renamed state is potentially stranded', async () => {
    // After v2 deploy, actor in v1 'active' state has no corresponding state in v2
    // The migration engine would need to route it, or it stays on v1
    await new Promise(r => setTimeout(r, 1500));

    const r = await state(activeActorId);
    assert.equal(r.status, 200);
    const sv = r.body.stateValue;
    // Actor is either:
    // - still on v1 (stateValue: 'active') — safe, stayed on v1
    // - migrated to v2 initial (stateValue: 'trial') — lost state
    // - in some error state
    console.log(`  Actor in renamed 'active' state after v2 deploy: stateValue='${sv}'`);
    assert.ok(sv !== undefined, 'Actor must have a state');
  });

  test('[GAP] scenario on v2 definition: old state name "active" is NOT valid', async () => {
    const r = await post('/v1/definitions/scenario', {
      definition: MIGRATE_B_V2,
      scenarios: [
        {
          name: 'v2 does not have "active" — CANCEL from trial',
          events: ['CONVERT'],
          expectedStates: ['active'],  // WRONG — v2 has 'paying' not 'active'
          expectDone: false,
        },
        {
          name: 'v2 has "paying" — correct name',
          events: ['CONVERT'],
          expectedStates: ['paying'],
          expectDone: false,
        },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, false, 'Old "active" name should fail in v2');
    assert.equal(r.body.results[1].passed, true,  'New "paying" name should pass in v2');
    console.log(`  v2 state name change: old='active' passed=${r.body.results[0].passed}, new='paying' passed=${r.body.results[1].passed}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C: Subtractive migration — v2 removes states and transitions
// ─────────────────────────────────────────────────────────────────────────────

describe('SC4-C: Subtractive migration — v2 removes "scheduled", "dead" states + transitions', () => {
  const ts   = Date.now();
  const v1Id = `wf-v1-${ts}`;
  const v2Id = `wf-v2-${ts}`;
  let scheduledActorId, deadActorId, idleActorId;

  before(async () => {
    await deploy(v1Id, MIGRATE_C_V1);

    const { id: a } = (await spawn(v1Id)).body;
    const { id: b } = (await spawn(v1Id)).body;
    const { id: c } = (await spawn(v1Id)).body;

    await send(a, 'SCHEDULE');   // → scheduled  (STATE REMOVED IN V2)
    await send(b, 'START');
    await send(b, 'FAIL');
    await send(b, 'GIVE_UP');   // → dead  (STATE REMOVED IN V2)

    scheduledActorId = a;
    deadActorId      = b;
    idleActorId      = c;
  });

  test('diff shows "scheduled" and "dead" removed, no new states', async () => {
    await deployForce(v2Id, MIGRATE_C_V2, v1Id);
    const r = await diff(v2Id);
    assert.equal(r.status, 200);
    const d = r.body.diff;

    assert.ok(d.statesRemoved.includes('scheduled'), `'scheduled' not in removed: ${JSON.stringify(d.statesRemoved)}`);
    assert.ok(d.statesRemoved.includes('dead'),      `'dead' not in removed: ${JSON.stringify(d.statesRemoved)}`);
    console.log(`  Subtractive diff: removed=[${d.statesRemoved}] added=[${d.statesAdded}]`);
  });

  test('[GAP] actors in removed states are stranded (need rescue deployment)', async () => {
    await new Promise(r => setTimeout(r, 1500));

    const rSched = await state(scheduledActorId);
    const rDead  = await state(deadActorId);

    console.log(`  'scheduled' actor post-v2: stateValue='${rSched.body.stateValue}'`);
    console.log(`  'dead' actor post-v2: stateValue='${rDead.body.stateValue}'`);

    // Both actors should still be accessible (StateKeep doesn't destroy actors)
    assert.equal(rSched.status, 200);
    assert.equal(rDead.status, 200);
  });

  test('v2 scenario: SCHEDULE event no longer works (removed transition)', async () => {
    const r = await post('/v1/definitions/scenario', {
      definition: MIGRATE_C_V2,
      scenarios: [
        {
          name: 'SCHEDULE removed in v2 — stays idle',
          events: ['SCHEDULE'],
          expectedStates: ['scheduled'],  // v2 has no 'scheduled'
          expectDone: false,
        },
        {
          name: 'START still works in v2',
          events: ['START'],
          expectedStates: ['running'],
          expectDone: false,
        },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, false, 'SCHEDULE should fail in v2 — state removed');
    assert.equal(r.body.results[1].passed, true,  'START should still work in v2');
  });

  test('v2 scenario: GIVE_UP removed — fail → no exit to dead', async () => {
    const r = await post('/v1/definitions/scenario', {
      definition: MIGRATE_C_V2,
      scenarios: [
        {
          name: 'GIVE_UP removed — stays in failed',
          events: ['START', 'FAIL', 'GIVE_UP'],
          expectedStates: ['running', 'failed', 'dead'],  // 'dead' removed
          expectDone: true,
        },
        {
          name: 'RETRY still works from failed',
          events: ['START', 'FAIL', 'RETRY', 'DONE'],
          expectedStates: ['running', 'failed', 'running', 'complete'],
          expectDone: true,
        },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, false, 'GIVE_UP path to dead should fail in v2');
    assert.equal(r.body.results[1].passed, true,  'RETRY path should work in v2');
    console.log(`  GIVE_UP step: state=${r.body.results[0].steps[2].state} expected=${r.body.results[0].steps[2].expected}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D: Multi-version refinement chain: v1 → v2 → v3
// ─────────────────────────────────────────────────────────────────────────────

describe('SC4-D: Multi-version chain v1 → v2 → v3 with actors at each version', () => {
  const ts   = Date.now();
  const v1Id = `chain-v1-${ts}`;
  const v2Id = `chain-v2-${ts}`;
  const v3Id = `chain-v3-${ts}`;

  const V1 = VALID_LINEAR;
  const V2 = {
    id: 'chain', initial: 'idle',
    states: {
      idle:         { on: { START: 'initializing', QUICK_START: 'processing' } },
      initializing: { on: { READY: 'processing', ABORT: 'idle' } },
      processing:   { on: { COMPLETE: 'done', FAIL: 'failed', PAUSE: 'paused' } },
      paused:       { on: { RESUME: 'processing', CANCEL: 'cancelled' } },
      failed:       { on: { RETRY: 'processing' } },
      done:         { type: 'final' },
      cancelled:    { type: 'final' },
    },
  };
  const V3 = {
    id: 'chain', initial: 'idle',
    states: {
      idle:         { on: { START: 'initializing', QUICK_START: 'processing' } },
      initializing: { on: { READY: 'processing', ABORT: 'idle' } },
      processing:   { on: { COMPLETE: 'reviewing', FAIL: 'failed', PAUSE: 'paused' } },
      reviewing:    { on: { APPROVE: 'done', REJECT: 'failed' } },  // NEW gate
      paused:       { on: { RESUME: 'processing', CANCEL: 'cancelled' } },
      failed:       { on: { RETRY: 'processing' } },
      done:         { type: 'final' },
      cancelled:    { type: 'final' },
    },
  };

  let a_v1, a_v2_mid, a_v1_done;

  before(async () => {
    await deploy(v1Id, V1);
    await deploy(v2Id, V2, v1Id);
    await deploy(v3Id, V3, v2Id);

    // Actor on v1
    const { id: i1 } = (await spawn(v1Id)).body;
    a_v1 = i1;

    // Actor advanced through v2 into processing
    const { id: i2 } = (await spawn(v2Id)).body;
    await send(i2, 'START');
    await send(i2, 'READY');  // → processing
    a_v2_mid = i2;

    // Actor on v1 already done
    const { id: i3 } = (await spawn(v1Id)).body;
    await send(i3, 'START');
    await send(i3, 'COMPLETE');
    a_v1_done = i3;
  });

  test('v1 → v2 diff shows initializing and paused added', async () => {
    const r = await diff(v2Id);
    assert.equal(r.status, 200);
    assert.ok(r.body.diff.statesAdded.includes('initializing'),
      `initializing not in added: ${JSON.stringify(r.body.diff.statesAdded)}`);
  });

  test('v2 → v3 diff shows reviewing added, COMPLETE transition changed', async () => {
    const r = await diff(v3Id);
    assert.equal(r.status, 200);
    const d = r.body.diff;
    assert.ok(d.statesAdded.includes('reviewing'),
      `reviewing not in added: ${JSON.stringify(d.statesAdded)}`);
    // COMPLETE now goes to reviewing instead of done
    const processingChange = d.transitionsChanged.find(c => c.state === 'processing');
    assert.ok(processingChange, 'processing transitions should be in diff');
    console.log(`  processing transition change: ${JSON.stringify(processingChange)}`);
  });

  test('v3 scenario: COMPLETE now requires APPROVE to reach done', async () => {
    const r = await post('/v1/definitions/scenario', {
      definition: V3,
      scenarios: [
        {
          name: 'old path: COMPLETE→done — FAILS in v3',
          events: ['START', 'READY', 'COMPLETE'],
          expectedStates: ['initializing', 'processing', 'done'],  // wrong
          expectDone: true,
        },
        {
          name: 'new path: COMPLETE→reviewing→APPROVE→done',
          events: ['START', 'READY', 'COMPLETE', 'APPROVE'],
          expectedStates: ['initializing', 'processing', 'reviewing', 'done'],
          expectDone: true,
        },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, false, 'Old path should fail in v3');
    assert.equal(r.body.results[1].passed, true,  'New path through reviewing should pass');
  });

  test('v1 actor state is accessible after 3-version chain deployment', async () => {
    await new Promise(r => setTimeout(r, 1500));
    const r = await state(a_v1);
    assert.equal(r.status, 200);
    assert.ok(r.body.stateValue, 'v1 actor must have a state');
  });

  test('already-done actors are unaffected by deployment chain', async () => {
    const r = await state(a_v1_done);
    assert.equal(r.status, 200);
    assert.equal(r.body.stateValue, 'done');
    assert.equal(r.body.done, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E: Refinement — hotfix at same anchor point
// ─────────────────────────────────────────────────────────────────────────────

describe('SC4-E: Hotfix refinement — v2 and v2-hotfix at same parent', () => {
  const ts     = Date.now();
  const v1Id   = `hotfix-v1-${ts}`;
  const v2Id   = `hotfix-v2-${ts}`;
  const hotfixId = `hotfix-v2fix-${ts}`;

  const V1 = VALID_LINEAR;
  const V2_BUGGY = {
    id: 'hotfix', initial: 'idle',
    states: {
      idle:       { on: { START: 'processing' } },
      processing: { on: { COMPLETE: 'stuck_not_final' } }, // BUG: target isn't final
      stuck_not_final: {},  // dead end — the bug
      done:       { type: 'final' },
    },
  };
  const V2_FIXED = {
    id: 'hotfix', initial: 'idle',
    states: {
      idle:       { on: { START: 'processing' } },
      processing: { on: { COMPLETE: 'done' } },  // FIXED
      done:       { type: 'final' },
    },
  };

  before(async () => {
    await deploy(v1Id, V1);
    await deploy(v2Id, V2_BUGGY, v1Id);
    await deploy(hotfixId, V2_FIXED, v1Id);  // same parent as v2 — refinement
  });

  test('buggy v2 scenario: COMPLETE leads to dead-end, not done', async () => {
    const r = await post('/v1/definitions/scenario', {
      definition: V2_BUGGY,
      scenarios: [
        {
          name: 'buggy v2: COMPLETE → stuck_not_final, not done',
          events: ['START', 'COMPLETE'],
          expectedStates: ['processing', 'done'],
          expectDone: true,
        },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, false, 'Buggy v2 should fail to reach done');
    console.log(`  Buggy v2 COMPLETE → ${r.body.results[0].finalState} (expected: done)`);
  });

  test('hotfix v2 scenario: COMPLETE now reaches done', async () => {
    const r = await post('/v1/definitions/scenario', {
      definition: V2_FIXED,
      scenarios: [
        {
          name: 'hotfix: COMPLETE → done',
          events: ['START', 'COMPLETE'],
          expectedStates: ['processing', 'done'],
          expectDone: true,
        },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, true, 'Hotfix should reach done correctly');
  });

  test('actors spawned on hotfix never get stuck', async () => {
    const { id } = (await spawn(hotfixId)).body;
    await send(id, 'START');
    const r = await send(id, 'COMPLETE');
    assert.equal(r.body.stateValue, 'done');
    assert.equal(r.body.done, true);
  });
});
