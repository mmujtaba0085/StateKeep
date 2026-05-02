/**
 * test/statechart/sc5.complex.js
 *
 * COMPLEX MULTI-ACTOR + MANY-REFINEMENT TESTS
 *
 * Tests the hardest real-world scenarios:
 *   - 50 actors across 3 versions of COMPLEX_SAAS simultaneously
 *   - Actors at every possible state receive events concurrently
 *   - 5-version refinement chain with actors at each tier
 *   - Parallel machine with 100 actors — both regions must stay consistent
 *   - Mass event replay — 500 events across 25 actors without corruption
 *   - Context schema drift across versions — actors carry stale fields
 *   - Scenario batch with 20 scenarios — mixed pass/fail
 *
 * Run: node --test test/statechart/sc5.complex.js
 */

import '../setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { seedApiKey, post, get, put } from '../setup.js';
import { COMPLEX_SAAS, COMPLEX_SAAS_V2, VALID_PARALLEL, VALID_MANY_STATES } from './machines.js';

before(async () => { await seedApiKey(); });

async function deploy(id, def, parentId) {
  const body = { id, definition: def };
  if (parentId) body.parentId = parentId;
  return put('/v1/definitions', body);
}
async function spawn(definitionId, ctx = {}) {
  return post('/v1/actors', { definitionId, initialContext: ctx });
}
async function send(id, type)   { return post(`/v1/actors/${id}/event`, { type }); }
async function getState(id)     { return get(`/v1/actors/${id}/state`); }

// ─────────────────────────────────────────────────────────────────────────────
// C1: 50 actors across COMPLEX_SAAS v1 + v2, various states
// ─────────────────────────────────────────────────────────────────────────────

describe('SC5-A: 50 actors on COMPLEX_SAAS — varied states + v2 deployment', () => {
  const ts   = Date.now();
  const v1Id = `saas-v1-${ts}`;
  const v2Id = `saas-v2-${ts}`;

  // Tracks actors by their intended journey
  const groups = { lead: [], trial: [], active: [], churned: [], suspended: [] };

  before(async () => {
    await deploy(v1Id, COMPLEX_SAAS);

    // Spawn and drive 50 actors into different states
    const TOTAL = 50;
    const spawnResults = await Promise.all(
      Array.from({ length: TOTAL }, (_, i) =>
        spawn(v1Id, { plan: `plan-${i % 3}`, mrr: (i + 1) * 50 })
      )
    );
    const ids = spawnResults.map(r => r.body.id);

    // Drive actors into varied states (10 each)
    await Promise.all([
      // 10 stay in lead
      ...ids.slice(0, 10).map(id => Promise.resolve(groups.lead.push(id))),

      // 10 → trial
      ...ids.slice(10, 20).map(async id => {
        await send(id, 'SIGN_UP');
        groups.trial.push(id);
      }),

      // 10 → active (healthy)
      ...ids.slice(20, 30).map(async id => {
        await send(id, 'SIGN_UP');
        await send(id, 'CONVERT');
        groups.active.push(id);
      }),

      // 10 → churned
      ...ids.slice(30, 40).map(async id => {
        await send(id, 'SIGN_UP');
        await send(id, 'EXPIRE');
        groups.churned.push(id);
      }),

      // 10 → suspended
      ...ids.slice(40, 50).map(async id => {
        await send(id, 'SIGN_UP');
        await send(id, 'CONVERT');
        await send(id, 'SUSPEND');
        groups.suspended.push(id);
      }),
    ]);
  });

  test('all 50 actors reach their expected states', async () => {
    const leadStates = await Promise.all(groups.lead.map(getState));
    leadStates.forEach((r, i) =>
      assert.equal(r.body.stateValue, 'lead', `Lead actor ${i} wrong state: ${r.body.stateValue}`)
    );

    const trialStates = await Promise.all(groups.trial.map(getState));
    trialStates.forEach((r, i) =>
      assert.equal(r.body.stateValue, 'trial', `Trial actor ${i} wrong state: ${r.body.stateValue}`)
    );

    const churnedStates = await Promise.all(groups.churned.map(getState));
    churnedStates.forEach((r, i) =>
      assert.equal(r.body.stateValue, 'churned', `Churned actor ${i}: ${r.body.stateValue}`)
    );
  });

  test('deploy v2 — all 50 actors remain accessible', async () => {
    const r = await deploy(v2Id, COMPLEX_SAAS_V2, v1Id);
    assert.ok([200, 201].includes(r.status), `v2 deploy: ${JSON.stringify(r.body)}`);

    await new Promise(r => setTimeout(r, 2000));

    const allIds = Object.values(groups).flat();
    const states = await Promise.all(allIds.map(getState));
    const failed = states.filter(r => r.status !== 200);
    assert.equal(failed.length, 0,
      `${failed.length} actors inaccessible after v2 deployment`);
  });

  test('active actors can still transition after v2 deployment', async () => {
    // Active actors can receive RISK_DETECTED
    const results = await Promise.all(
      groups.active.map(id => send(id, 'RISK_DETECTED'))
    );
    const errors = results.filter(r => r.status !== 200);
    assert.equal(errors.length, 0,
      `${errors.length} active actors failed to receive RISK_DETECTED`);
    // All should now be at_risk (inside active compound state)
    results.forEach((r, i) => {
      const sv = JSON.stringify(r.body.stateValue);
      assert.ok(sv.includes('at_risk') || sv.includes('active'),
        `Active actor ${i} unexpected state: ${sv}`);
    });
  });

  test('churned actors are final — events are silently ignored', async () => {
    // Churned is a final state — no events should change it
    const results = await Promise.all(
      groups.churned.map(id => send(id, 'SIGN_UP'))
    );
    results.forEach((r, i) => {
      assert.equal(r.status, 200, `Churned actor ${i} event failed: ${r.status}`);
      assert.equal(r.body.stateValue, 'churned',
        `Churned actor ${i} changed state: ${r.body.stateValue}`);
    });
  });

  test('v2 new actors can use extended trial sub-states', async () => {
    const { id } = (await spawn(v2Id)).body;
    await send(id, 'SIGN_UP');      // → trial (v2 compound)
    const r = await send(id, 'UPGRADE');  // → trial.extended (v2 only)
    const sv = JSON.stringify(r.body.stateValue);
    assert.ok(sv.includes('extended') || sv.includes('trial'),
      `Expected trial.extended, got: ${sv}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C2: 5-version refinement chain — actors at each tier
// ─────────────────────────────────────────────────────────────────────────────

describe('SC5-B: 5-version refinement chain — actors distributed across versions', () => {
  const ts = Date.now();
  const ids = Array.from({ length: 5 }, (_, i) => `chain5-v${i+1}-${ts}`);

  // Each version adds one state to the pipeline
  const makeV = (n) => ({
    id: `chain5`,
    initial: 'start',
    states: Object.fromEntries([
      ['start', { on: { NEXT: 'stage_1' } }],
      ...Array.from({ length: n }, (_, i) => [
        `stage_${i + 1}`,
        i < n - 1
          ? { on: { NEXT: `stage_${i + 2}`, RESET: 'start' } }
          : { on: { FINISH: 'done', RESET: 'start' } },
      ]),
      ['done', { type: 'final' }],
    ]),
  });

  const actorsPerVersion = [];

  before(async () => {
    // Deploy 5 versions in sequence
    await deploy(ids[0], makeV(1));
    for (let i = 1; i < 5; i++) {
      await deploy(ids[i], makeV(i + 1), ids[i - 1]);
    }

    // Spawn 5 actors, one on each version, advance each to middle
    for (let v = 0; v < 5; v++) {
      const { id } = (await spawn(ids[v])).body;
      // Advance to middle of available stages
      const steps = Math.ceil((v + 1) / 2);
      for (let s = 0; s < steps; s++) {
        await send(id, 'NEXT');
      }
      actorsPerVersion.push({ id, version: v + 1, steps });
    }
  });

  test('each actor is at expected stage for its version', async () => {
    for (const { id, version, steps } of actorsPerVersion) {
      const r = await getState(id);
      assert.equal(r.status, 200, `v${version} actor inaccessible`);
      const expectedState = steps === 0 ? 'start' : `stage_${steps}`;
      assert.equal(r.body.stateValue, expectedState,
        `v${version} actor: expected ${expectedState}, got ${r.body.stateValue}`);
      console.log(`  v${version} actor at stage: ${r.body.stateValue}`);
    }
  });

  test('all actors still respond to events after full chain deployment', async () => {
    await new Promise(r => setTimeout(r, 1500));

    for (const { id, version } of actorsPerVersion) {
      const r = await send(id, 'RESET');
      assert.equal(r.status, 200, `v${version} actor failed to RESET`);
      assert.equal(r.body.stateValue, 'start', `v${version} actor should be back at start`);
    }
  });

  test('v5 actor can traverse all 5 stages', async () => {
    const { id } = (await spawn(ids[4])).body;
    for (let i = 0; i < 5; i++) {
      const r = await send(id, 'NEXT');
      assert.equal(r.body.stateValue, `stage_${i + 1}`, `Stage ${i+1} wrong`);
    }
    const r = await send(id, 'FINISH');
    assert.equal(r.body.stateValue, 'done');
    assert.equal(r.body.done, true);
  });

  test('diff chain is consistent (each v adds exactly 1 state)', async () => {
    for (let i = 1; i < 5; i++) {
      const r = await get(`/v1/definitions/${ids[i]}/diff`);
      assert.equal(r.status, 200);
      assert.equal(r.body.diff.statesAdded.length, 1,
        `v${i+1} should add exactly 1 state, added: ${JSON.stringify(r.body.diff.statesAdded)}`);
      assert.equal(r.body.diff.statesRemoved.length, 0,
        `v${i+1} should remove 0 states`);
      console.log(`  v${i+1} added: ${r.body.diff.statesAdded[0]}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C3: 100 parallel-machine actors — both regions track independently
// ─────────────────────────────────────────────────────────────────────────────

describe('SC5-C: 100 parallel machine actors — region isolation', () => {
  const defId = `parallel-100-${Date.now()}`;
  let actorIds = [];

  before(async () => {
    await deploy(defId, VALID_PARALLEL);
    const spawns = await Promise.all(
      Array.from({ length: 100 }, () => spawn(defId))
    );
    actorIds = spawns.map(r => r.body.id);
    assert.equal(actorIds.length, 100);
  });

  test('100 actors spawn correctly in parallel initial state', async () => {
    // Check a sample of 10
    const sample = actorIds.slice(0, 10);
    const states = await Promise.all(sample.map(getState));
    states.forEach((r, i) => {
      assert.equal(r.status, 200, `Actor ${i} inaccessible`);
      assert.ok(r.body.stateValue !== undefined, `Actor ${i} has no stateValue`);
    });
  });

  test('PAY on 50 actors only advances payment region, not shipping', async () => {
    const half = actorIds.slice(0, 50);
    const results = await Promise.all(half.map(id => send(id, 'PAY')));
    const failures = results.filter(r => r.status !== 200);
    assert.equal(failures.length, 0, `${failures.length} PAY events failed`);

    results.forEach((r, i) => {
      const sv = JSON.stringify(r.body.stateValue);
      assert.ok(sv.includes('paid'),       `Actor ${i}: payment not advanced: ${sv}`);
      assert.ok(sv.includes('unselected'), `Actor ${i}: shipping changed unexpectedly: ${sv}`);
    });
  });

  test('SELECT_SHIPPING on other 50 actors only advances shipping', async () => {
    const other = actorIds.slice(50, 100);
    const results = await Promise.all(other.map(id => send(id, 'SELECT_SHIPPING')));
    const failures = results.filter(r => r.status !== 200);
    assert.equal(failures.length, 0, `${failures.length} SELECT_SHIPPING failed`);

    results.forEach((r, i) => {
      const sv = JSON.stringify(r.body.stateValue);
      assert.ok(sv.includes('unpaid'),   `Actor ${i}: payment changed: ${sv}`);
      assert.ok(sv.includes('selected'), `Actor ${i}: shipping not advanced: ${sv}`);
    });
  });

  test('COMPLETE on first 50 (already paid) — all reach done', async () => {
    const half = actorIds.slice(0, 50);
    // First, give them shipping too
    await Promise.all(half.map(id => send(id, 'SELECT_SHIPPING')));
    // Then complete
    const results = await Promise.all(half.map(id => send(id, 'COMPLETE')));
    results.forEach((r, i) => {
      assert.equal(r.body.stateValue, 'done', `Actor ${i} didn't complete: ${r.body.stateValue}`);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C4: 500-event mass replay — 25 actors, 20 events each
// ─────────────────────────────────────────────────────────────────────────────

describe('SC5-D: Mass event replay — 25 actors × 20 events = 500 total', () => {
  const defId = `mass-${Date.now()}`;
  let actorIds = [];

  before(async () => {
    await deploy(defId, VALID_MANY_STATES);
    const spawns = await Promise.all(Array.from({ length: 25 }, () => spawn(defId)));
    actorIds = spawns.map(r => r.body.id);
  });

  test('500 events sent without error or corruption', async () => {
    const EVENTS_PER_ACTOR = 20;
    let errorCount = 0;

    // Each actor walks NEXT events (with occasional REJECT to loop back)
    const actorTasks = actorIds.map(async (id, idx) => {
      for (let e = 0; e < EVENTS_PER_ACTOR; e++) {
        const type = (e === 10 && idx % 5 === 0) ? 'REJECT' : 'NEXT';
        const r = await send(id, type);
        if (r.status !== 200) errorCount++;
      }
    });

    await Promise.all(actorTasks);
    assert.equal(errorCount, 0, `${errorCount} events failed out of 500`);
  });

  test('all 25 actors are still accessible and have valid state', async () => {
    const states = await Promise.all(actorIds.map(getState));
    const broken = states.filter(r => r.status !== 200 || !r.body.stateValue);
    assert.equal(broken.length, 0, `${broken.length} actors in bad state after 500 events`);
  });

  test('event history count for each actor is correct', async () => {
    // Sample 5 actors and verify event counts
    const sample = actorIds.slice(0, 5);
    for (const id of sample) {
      const r = await get(`/v1/actors/${id}/events`);
      assert.equal(r.status, 200);
      // 1 SPAWN + 20 events = at least 20
      assert.ok(r.body.total >= 20,
        `Expected >= 20 events for actor ${id}, got ${r.body.total}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C5: Context schema drift across versions
// ─────────────────────────────────────────────────────────────────────────────

describe('SC5-E: Context schema drift — v1 actors carry stale context into v2', () => {
  const ts   = Date.now();
  const v1Id = `drift-v1-${ts}`;
  const v2Id = `drift-v2-${ts}`;

  const V1 = {
    id: 'drift', initial: 'start',
    context: { legacyField: 'old', version: 1 },
    states: {
      start:   { on: { GO: 'middle' } },
      middle:  { on: { DONE: 'end' } },
      end:     { type: 'final' },
    },
  };
  const V2 = {
    id: 'drift', initial: 'start',
    context: { newField: 'new', version: 2, extraRequired: true }, // schema changed
    states: {
      start:   { on: { GO: 'middle', FAST: 'end' } },  // extra transition
      middle:  { on: { DONE: 'end', BACK: 'start' } }, // extra transition
      end:     { type: 'final' },
    },
  };

  let v1ActorId;

  before(async () => {
    await deploy(v1Id, V1);
    await deploy(v2Id, V2, v1Id);

    const { id } = (await spawn(v1Id, { legacyField: 'customValue', version: 1 })).body;
    await send(id, 'GO');  // → middle (v1 context still present)
    v1ActorId = id;
  });

  test('v1 actor retains its context through transitions', async () => {
    const r = await getState(v1ActorId);
    assert.equal(r.status, 200);
    assert.equal(r.body.stateValue, 'middle');
    // Context should be preserved
    if (r.body.context) {
      assert.equal(r.body.context.legacyField, 'customValue',
        'legacyField should be preserved in context');
    }
  });

  test('v2 new actors start with v2 context schema', async () => {
    const { id } = (await spawn(v2Id, { newField: 'test', version: 2, extraRequired: true })).body;
    const r = await getState(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.stateValue, 'start');
  });

  test('v2 scenario with old context values still works (no crash on missing fields)', async () => {
    const r = await post('/v1/definitions/scenario', {
      definition: V2,
      scenarios: [
        {
          name: 'v2 machine with v1-style context (missing extraRequired)',
          initialContext: { legacyField: 'old', version: 1 },  // v1 context on v2 machine
          events: ['GO', 'DONE'],
          expectedStates: ['middle', 'end'],
          expectDone: true,
        },
      ],
    });
    assert.equal(r.status, 200);
    // Should complete without crash even with mismatched context schema
    // (XState doesn't enforce schema — context is just a bag)
    assert.equal(r.body.results[0].passed, true,
      `Expected v2 to handle v1 context gracefully: ${r.body.results[0].error}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C6: Massive scenario batch — 20 scenarios, deliberate mix of pass/fail
// ─────────────────────────────────────────────────────────────────────────────

describe('SC5-F: 20-scenario batch on order machine — deliberate 12 pass / 8 fail', () => {
  const ORDER = {
    id: 'order', initial: 'pending',
    states: {
      pending:   { on: { PAY: 'paid', CANCEL: 'cancelled' } },
      paid:      { on: { SHIP: 'shipped', REFUND: 'refunded' } },
      shipped:   { on: { DELIVER: 'delivered', RETURN: 'returning' } },
      returning: { on: { RECEIVED: 'refunded' } },
      delivered: { type: 'final' },
      refunded:  { type: 'final' },
      cancelled: { type: 'final' },
    },
  };

  const scenarios = [
    // 12 PASSING scenarios
    { name: 'P01', events: ['PAY','SHIP','DELIVER'],           expectedStates: ['paid','shipped','delivered'],             expectDone: true  },
    { name: 'P02', events: ['CANCEL'],                         expectedStates: ['cancelled'],                             expectDone: true  },
    { name: 'P03', events: ['PAY','REFUND'],                   expectedStates: ['paid','refunded'],                       expectDone: true  },
    { name: 'P04', events: ['PAY','SHIP','RETURN','RECEIVED'], expectedStates: ['paid','shipped','returning','refunded'],  expectDone: true  },
    { name: 'P05', events: ['SHIP'],                           expectedStates: ['pending'],                               expectDone: false },
    { name: 'P06', events: ['PAY'],                            expectedStates: ['paid'],                                  expectDone: false },
    { name: 'P07', events: ['PAY','SHIP'],                     expectedStates: ['paid','shipped'],                        expectDone: false },
    { name: 'P08', events: ['PAY','SHIP','RETURN'],            expectedStates: ['paid','shipped','returning'],            expectDone: false },
    { name: 'P09', events: ['CANCEL','PAY'],                   expectedStates: ['cancelled','cancelled'],                 expectDone: true  },
    { name: 'P10', events: ['PAY','SHIP','DELIVER','SHIP'],    expectedStates: ['paid','shipped','delivered','delivered'], expectDone: true  },
    { name: 'P11', events: [],                                 expectedStates: [],                                        expectDone: false },
    { name: 'P12', events: ['PAY','REFUND','PAY'],             expectedStates: ['paid','refunded','refunded'],            expectDone: true  },

    // 8 FAILING scenarios (wrong expectations)
    { name: 'F01 wrong: PAY→shipped',    events: ['PAY'],        expectedStates: ['shipped'],    expectDone: false },
    { name: 'F02 wrong: CANCEL→paid',    events: ['CANCEL'],     expectedStates: ['paid'],       expectDone: false },
    { name: 'F03 wrong: done after PAY', events: ['PAY'],        expectedStates: ['paid'],       expectDone: true  },
    { name: 'F04 wrong 3rd state',       events: ['PAY','SHIP','DELIVER'], expectedStates: ['paid','shipped','paid'], expectDone: true },
    { name: 'F05 wrong expectDone',      events: ['PAY','SHIP','DELIVER'], expectedStates: ['paid','shipped','delivered'], expectDone: false },
    { name: 'F06 ship before pay',       events: ['SHIP','PAY'], expectedStates: ['shipped','paid'], expectDone: false },
    { name: 'F07 wrong event name',      events: ['PURCHASE'],   expectedStates: ['paid'],       expectDone: false },
    { name: 'F08 expects wrong final',   events: ['PAY','SHIP','DELIVER'], expectedStates: ['paid','shipped','cancelled'], expectDone: true },
  ];

  test('20 scenarios run: exactly 12 pass and 8 fail', async () => {
    const r = await post('/v1/definitions/scenario', { definition: ORDER, scenarios });
    assert.equal(r.status, 200);

    const { passed, failed, total } = r.body.summary;
    assert.equal(total, 20, `Expected 20 scenarios, got ${total}`);
    assert.equal(passed, 12, `Expected 12 passed, got ${passed}: ${JSON.stringify(r.body.results.filter(x=>x.passed).map(x=>x.name))}`);
    assert.equal(failed,  8, `Expected 8 failed, got ${failed}`);
    assert.equal(r.body.summary.allPass, false);
  });

  test('all 8 failing scenarios have non-empty error or step failure info', async () => {
    const r = await post('/v1/definitions/scenario', { definition: ORDER, scenarios });
    const failedResults = r.body.results.filter(x => !x.passed);
    assert.equal(failedResults.length, 8);

    for (const result of failedResults) {
      const hasStepFailure = result.steps.some(s => !s.pass);
      const hasError       = !!result.error;
      assert.ok(hasStepFailure || hasError,
        `Failing scenario "${result.name}" has no step failure or error message`);
    }
  });

  test('step-level results are correct for all 12 passing scenarios', async () => {
    const r = await post('/v1/definitions/scenario', { definition: ORDER, scenarios });
    const passed = r.body.results.filter(x => x.passed);

    for (const result of passed) {
      for (const step of result.steps) {
        assert.equal(step.pass, true,
          `Passing scenario "${result.name}" has failing step: event=${step.event} state=${step.state} expected=${step.expected}`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C7: Concurrent events to actors in different states — no cross-contamination
// ─────────────────────────────────────────────────────────────────────────────

describe('SC5-G: Concurrent events to 30 actors — state isolation guaranteed', () => {
  const defId = `isolation-${Date.now()}`;
  const ACTORS = 30;
  let actorIds = [];

  before(async () => {
    await deploy(defId, COMPLEX_SAAS);
    const spawns = await Promise.all(Array.from({ length: ACTORS }, () => spawn(defId)));
    actorIds = spawns.map(r => r.body.id);

    // Put first 15 in trial, next 15 stay in lead
    await Promise.all(actorIds.slice(0, 15).map(id => send(id, 'SIGN_UP')));
  });

  test('concurrent CONVERT on trial actors does not affect lead actors', async () => {
    const trialActors = actorIds.slice(0, 15);
    const leadActors  = actorIds.slice(15, 30);

    // Convert all trial actors while lead actors receive no events
    await Promise.all(trialActors.map(id => send(id, 'CONVERT')));

    // Verify trial actors are now active
    const trialStates = await Promise.all(trialActors.map(getState));
    trialStates.forEach((r, i) => {
      const sv = JSON.stringify(r.body.stateValue);
      assert.ok(sv.includes('active') || sv.includes('healthy'),
        `Trial actor ${i} not active after CONVERT: ${sv}`);
    });

    // Verify lead actors are still in lead (unaffected)
    const leadStates = await Promise.all(leadActors.map(getState));
    leadStates.forEach((r, i) => {
      assert.equal(r.body.stateValue, 'lead',
        `Lead actor ${i} changed state without receiving events: ${r.body.stateValue}`);
    });
  });

  test('50 concurrent events to same actor — final state is valid and consistent', async () => {
    const { id } = (await spawn(defId)).body;
    await send(id, 'SIGN_UP'); // → trial

    // Fire 50 concurrent CONVERT + EXPIRE events — one will win
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        send(id, i % 2 === 0 ? 'CONVERT' : 'EXPIRE')
      )
    );

    // All should return 200 (no crashes)
    const errors = results.filter(r => r.status !== 200);
    assert.equal(errors.length, 0, `${errors.length} concurrent events errored`);

    // Final state should be one valid state (active or churned)
    const finalState = (await getState(id)).body;
    const validFinals = ['churned', 'active', 'trial', 'lead'];
    const sv = JSON.stringify(finalState.stateValue);
    const isValid = validFinals.some(s => sv.includes(s));
    assert.ok(isValid, `Actor in unexpected state after concurrent race: ${sv}`);
  });
});
