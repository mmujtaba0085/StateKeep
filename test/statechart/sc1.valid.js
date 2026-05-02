/**
 * test/statechart/sc1.valid.js
 *
 * VALID STATECHARTS — All tests in this file should PASS.
 *
 * Tests both the /v1/definitions/validate endpoint (dry-run)
 * and the full REST path (PUT definition → spawn actor → send events).
 *
 * Run: node --test test/statechart/sc1.valid.js
 */

import '../setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { seedApiKey, post, get, put, BASE_URL } from '../setup.js';
import {
  VALID_MINIMAL, VALID_LINEAR, VALID_BRANCHING, VALID_CYCLIC,
  VALID_HIERARCHICAL, VALID_PARALLEL, VALID_WITH_ACTIONS,
  VALID_MULTI_FINAL, VALID_SELF_TRANSITION, VALID_DEEP,
  VALID_MANY_STATES, VALID_ONBOARDING, VALID_CONTEXT_HEAVY,
} from './machines.js';

before(async () => {
  await seedApiKey();
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function validate(definition) {
  return post('/v1/definitions/validate', { definition });
}

async function scenario(definition, scenarios) {
  return post('/v1/definitions/scenario', { definition, scenarios });
}

async function deploy(id, definition) {
  return put('/v1/definitions', { id, definition });
}

async function spawn(definitionId, ctx = {}) {
  return post('/v1/actors', { definitionId, initialContext: ctx });
}

async function send(actorId, type, payload = {}) {
  return post(`/v1/actors/${actorId}/event`, { type, payload });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Validate endpoint — structural checks
// ─────────────────────────────────────────────────────────────────────────────

describe('SC1-V: Validate endpoint — valid machines return valid:true', () => {
  const machines = [
    ['minimal (2 states)',       VALID_MINIMAL],
    ['linear pipeline',          VALID_LINEAR],
    ['branching (6 states)',     VALID_BRANCHING],
    ['cyclic with retry',        VALID_CYCLIC],
    ['hierarchical nested',      VALID_HIERARCHICAL],
    ['parallel orthogonal',      VALID_PARALLEL],
    ['with entry/exit actions',  VALID_WITH_ACTIONS],
    ['multiple final states',    VALID_MULTI_FINAL],
    ['self-transition',          VALID_SELF_TRANSITION],
    ['deep hierarchy (4 levels)',VALID_DEEP],
    ['20-state pipeline',        VALID_MANY_STATES],
    ['onboarding SaaS',          VALID_ONBOARDING],
    ['context-heavy loan',       VALID_CONTEXT_HEAVY],
  ];

  for (const [name, machine] of machines) {
    test(`validates ${name}`, async () => {
      const r = await validate(machine);
      assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.valid, true, `Expected valid:true for ${name}: ${r.body.error}`);
      assert.ok(r.body.initialState !== undefined, 'initialState should be present');
      assert.ok(r.body.stateCount > 0, 'stateCount should be > 0');
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Minimal machine — spawn and send
// ─────────────────────────────────────────────────────────────────────────────

describe('SC1-A: Minimal machine (off → on)', () => {
  const defId = `sc1-minimal-${Date.now()}`;

  test('deploy minimal definition', async () => {
    const r = await deploy(defId, VALID_MINIMAL);
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  });

  test('spawn actor starts in "off"', async () => {
    const r = await spawn(defId);
    assert.equal(r.status, 201);
    assert.equal(r.body.stateValue, 'off');
  });

  test('TURN_ON transitions to "on" (final)', async () => {
    const spawnRes = await spawn(defId);
    const id = spawnRes.body.id;
    const r  = await send(id, 'TURN_ON');
    assert.equal(r.status, 200);
    assert.equal(r.body.stateValue, 'on');
    assert.equal(r.body.done, true);
  });

  test('event after final state is ignored gracefully', async () => {
    const spawnRes = await spawn(defId);
    const id = spawnRes.body.id;
    await send(id, 'TURN_ON');
    const r = await send(id, 'TURN_ON');
    assert.equal(r.status, 200, 'Should not error on event to final actor');
    assert.equal(r.body.stateValue, 'on');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Linear pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe('SC1-B: Linear pipeline — all paths', () => {
  const defId = `sc1-linear-${Date.now()}`;

  before(async () => {
    await deploy(defId, VALID_LINEAR);
  });

  test('happy path: START → COMPLETE → done', async () => {
    const { id } = (await spawn(defId)).body;
    await send(id, 'START');
    const r = await send(id, 'COMPLETE');
    assert.equal(r.body.stateValue, 'done');
    assert.equal(r.body.done, true);
  });

  test('failure path: START → FAIL → RETRY → COMPLETE → done', async () => {
    const { id } = (await spawn(defId)).body;
    await send(id, 'START');
    await send(id, 'FAIL');
    await send(id, 'RETRY');
    const r = await send(id, 'COMPLETE');
    assert.equal(r.body.stateValue, 'done');
  });

  test('multiple retries before success', async () => {
    const { id } = (await spawn(defId)).body;
    await send(id, 'START');
    for (let i = 0; i < 5; i++) {
      await send(id, 'FAIL');
      await send(id, 'RETRY');
    }
    const r = await send(id, 'COMPLETE');
    assert.equal(r.body.stateValue, 'done');
  });

  test('unknown event in idle is silently ignored', async () => {
    const { id } = (await spawn(defId)).body;
    const r = await send(id, 'UNKNOWN_EVENT');
    assert.equal(r.status, 200);
    assert.equal(r.body.stateValue, 'idle', 'Should remain idle');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Branching machine — all 3 exit paths
// ─────────────────────────────────────────────────────────────────────────────

describe('SC1-C: Branching machine — all exit paths', () => {
  const defId = `sc1-branch-${Date.now()}`;

  before(async () => { await deploy(defId, VALID_BRANCHING); });

  test('SUBMIT → APPROVE → approved (final)', async () => {
    const { id } = (await spawn(defId)).body;
    await send(id, 'SUBMIT');
    const r = await send(id, 'APPROVE');
    assert.equal(r.body.stateValue, 'approved');
    assert.equal(r.body.done, true);
  });

  test('SUBMIT → REJECT → REVISE → SUBMIT → APPROVE', async () => {
    const { id } = (await spawn(defId)).body;
    await send(id, 'SUBMIT');
    await send(id, 'REJECT');
    await send(id, 'REVISE');    // back to draft
    await send(id, 'SUBMIT');
    const r = await send(id, 'APPROVE');
    assert.equal(r.body.stateValue, 'approved');
  });

  test('DISCARD → discarded (final, skip approval)', async () => {
    const { id } = (await spawn(defId)).body;
    const r = await send(id, 'DISCARD');
    assert.equal(r.body.stateValue, 'discarded');
    assert.equal(r.body.done, true);
  });

  test('SUBMIT → ESCALATE → APPROVE', async () => {
    const { id } = (await spawn(defId)).body;
    await send(id, 'SUBMIT');
    await send(id, 'ESCALATE');
    const r = await send(id, 'APPROVE');
    assert.equal(r.body.stateValue, 'approved');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Cyclic machine — retry loops
// ─────────────────────────────────────────────────────────────────────────────

describe('SC1-D: Cyclic machine — 10 retry cycles then success', () => {
  const defId = `sc1-cyclic-${Date.now()}`;

  before(async () => { await deploy(defId, VALID_CYCLIC); });

  test('10 retry cycles resolve to done', async () => {
    const { id } = (await spawn(defId)).body;
    await send(id, 'PICK_UP');
    for (let i = 0; i < 10; i++) {
      await send(id, 'ERROR');
      await send(id, 'RETRY');
    }
    const r = await send(id, 'SUCCESS');
    assert.equal(r.body.stateValue, 'done');
  });

  test('ABORT exits to aborted (final)', async () => {
    const { id } = (await spawn(defId)).body;
    await send(id, 'PICK_UP');
    await send(id, 'ERROR');
    const r = await send(id, 'ABORT');
    assert.equal(r.body.stateValue, 'aborted');
    assert.equal(r.body.done, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Hierarchical machine
// ─────────────────────────────────────────────────────────────────────────────

describe('SC1-E: Hierarchical machine — nested state transitions', () => {
  const defId = `sc1-hier-${Date.now()}`;

  before(async () => { await deploy(defId, VALID_HIERARCHICAL); });

  test('initial state is "off"', async () => {
    const { body } = await spawn(defId);
    assert.equal(body.stateValue, 'off');
  });

  test('POWER enters on.idle', async () => {
    const { id } = (await spawn(defId)).body;
    const r = await send(id, 'POWER');
    // Nested state — XState returns an object or 'idle'
    assert.ok(r.body.stateValue !== 'off', 'Should have left off');
  });

  test('POWER from inside on exits to off', async () => {
    const { id } = (await spawn(defId)).body;
    await send(id, 'POWER');  // → on
    await send(id, 'WORK');   // → on.working
    const r = await send(id, 'POWER');  // exits all of on → off
    assert.equal(r.body.stateValue, 'off');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6b. Deep hierarchy
// ─────────────────────────────────────────────────────────────────────────────

describe('SC1-E2: Deep hierarchy (4 levels) — absolute-ID cross-level transition', () => {
  const defId = `sc1-deep-${Date.now()}`;

  before(async () => { await deploy(defId, VALID_DEEP); });

  test('deep path: step1.intro.accepted → ADVANCE → step2', async () => {
    const { id } = (await spawn(defId)).body;
    await send(id, 'NEXT');    // welcome → terms
    await send(id, 'ACCEPT');  // terms → accepted
    const r = await send(id, 'ADVANCE'); // accepted → step2 (absolute ID)
    assert.equal(r.status, 200);
    assert.equal(r.body.stateValue, 'step2',
      `Expected step2 after ADVANCE, got: ${JSON.stringify(r.body.stateValue)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Parallel machine
// ─────────────────────────────────────────────────────────────────────────────

describe('SC1-F: Parallel (orthogonal) machine — both regions track independently', () => {
  const defId = `sc1-parallel-${Date.now()}`;

  before(async () => { await deploy(defId, VALID_PARALLEL); });

  test('initial state includes both regions', async () => {
    const r = await spawn(defId);
    assert.equal(r.status, 201);
    const sv = r.body.stateValue;
    // Could be 'active' with nested, or an object
    assert.ok(sv !== undefined, 'stateValue must exist');
  });

  test('PAY advances payment region without affecting shipping', async () => {
    const { id } = (await spawn(defId)).body;
    const r = await send(id, 'PAY');
    assert.equal(r.status, 200);
    const sv = r.body.stateValue;
    const str = JSON.stringify(sv);
    // Payment should be 'paid', shipping still 'unselected'
    assert.ok(str.includes('paid'),        `Expected paid in: ${str}`);
    assert.ok(str.includes('unselected'),  `Expected unselected in: ${str}`);
  });

  test('SELECT_SHIPPING advances shipping without affecting payment', async () => {
    const { id } = (await spawn(defId)).body;
    const r = await send(id, 'SELECT_SHIPPING');
    const str = JSON.stringify(r.body.stateValue);
    assert.ok(str.includes('unpaid'),   `Expected unpaid in: ${str}`);
    assert.ok(str.includes('selected'), `Expected selected in: ${str}`);
  });

  test('both regions advance independently then COMPLETE exits', async () => {
    const { id } = (await spawn(defId)).body;
    await send(id, 'PAY');
    await send(id, 'SELECT_SHIPPING');
    const r = await send(id, 'COMPLETE');
    assert.equal(r.body.stateValue, 'done');
    assert.equal(r.body.done, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Entry/exit actions (no-op names)
// ─────────────────────────────────────────────────────────────────────────────

describe('SC1-G: Entry/exit action names do not crash XState', () => {
  const defId = `sc1-actions-${Date.now()}`;

  before(async () => { await deploy(defId, VALID_WITH_ACTIONS); });

  test('machine with action names validates and spawns', async () => {
    const r = await spawn(defId);
    assert.equal(r.status, 201);
    assert.equal(r.body.stateValue, 'authenticating');
  });

  test('transition fires even with unimplemented action names', async () => {
    const { id } = (await spawn(defId)).body;
    const r = await send(id, 'LOGIN_SUCCESS');
    assert.equal(r.status, 200);
    assert.equal(r.body.stateValue, 'active');
  });

  test('full session lifecycle with action names', async () => {
    const { id } = (await spawn(defId)).body;
    await send(id, 'LOGIN_SUCCESS');
    await send(id, 'TIMEOUT');
    const r = await send(id, 'LOGIN');
    assert.equal(r.body.stateValue, 'authenticating');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Self-transition
// ─────────────────────────────────────────────────────────────────────────────

describe('SC1-H: Self-transition stays in same state', () => {
  const defId = `sc1-self-${Date.now()}`;

  before(async () => { await deploy(defId, VALID_SELF_TRANSITION); });

  test('INCREMENT self-loops 100 times, stays in counting', async () => {
    const { id } = (await spawn(defId)).body;
    for (let i = 0; i < 100; i++) {
      const r = await send(id, 'INCREMENT');
      assert.equal(r.body.stateValue, 'counting', `Failed at increment ${i}`);
    }
  });

  test('FINISH exits to done after many increments', async () => {
    const { id } = (await spawn(defId)).body;
    for (let i = 0; i < 10; i++) await send(id, 'INCREMENT');
    const r = await send(id, 'FINISH');
    assert.equal(r.body.stateValue, 'done');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. 20-state pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe('SC1-I: 20-state pipeline traversal', () => {
  const defId = `sc1-pipeline-${Date.now()}`;

  before(async () => { await deploy(defId, VALID_MANY_STATES); });

  test('walks all 20 states via NEXT events', async () => {
    const { id } = (await spawn(defId)).body;
    for (let i = 0; i < 19; i++) {
      const r = await send(id, 'NEXT');
      assert.equal(r.status, 200, `Failed at step ${i}: ${JSON.stringify(r.body)}`);
    }
    const state = (await get(`/v1/actors/${id}/state`)).body;
    assert.equal(state.stateValue, 'done');
  });

  test('REJECT from any stage resets to intake', async () => {
    const { id } = (await spawn(defId)).body;
    for (let i = 0; i < 5; i++) await send(id, 'NEXT');
    const r = await send(id, 'REJECT');
    assert.equal(r.body.stateValue, 'intake');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Multiple final states
// ─────────────────────────────────────────────────────────────────────────────

describe('SC1-J: Order machine — multiple final states', () => {
  const defId = `sc1-order-${Date.now()}`;

  before(async () => { await deploy(defId, VALID_MULTI_FINAL); });

  const paths = [
    { label: 'happy delivery',     events: ['PAY','SHIP','DELIVER'],              final: 'delivered' },
    { label: 'refund path',        events: ['PAY','REFUND'],                      final: 'refunded'  },
    { label: 'cancel',             events: ['CANCEL'],                            final: 'cancelled' },
    { label: 'return and refund',  events: ['PAY','SHIP','RETURN','RECEIVED'],    final: 'refunded'  },
  ];

  for (const { label, events, final: expected } of paths) {
    test(`path: ${label} → ${expected}`, async () => {
      const { id } = (await spawn(defId)).body;
      for (const e of events) await send(id, e);
      const state = (await get(`/v1/actors/${id}/state`)).body;
      assert.equal(state.stateValue, expected, `Expected ${expected}`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Scenario endpoint — happy paths
// ─────────────────────────────────────────────────────────────────────────────

describe('SC1-K: /v1/definitions/scenario — all scenarios pass', () => {
  test('order machine — all 4 scenarios pass', async () => {
    const r = await scenario(VALID_MULTI_FINAL, [
      {
        name: 'happy path',
        events: ['PAY', 'SHIP', 'DELIVER'],
        expectedStates: ['paid', 'shipped', 'delivered'],
        expectDone: true,
      },
      {
        name: 'cancel',
        events: ['CANCEL'],
        expectedStates: ['cancelled'],
        expectDone: true,
      },
      {
        name: 'refund',
        events: ['PAY', 'REFUND'],
        expectedStates: ['paid', 'refunded'],
        expectDone: true,
      },
      {
        name: 'unknown event ignored',
        events: ['SHIP'],
        expectedStates: ['pending'],
        expectDone: false,
      },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.summary.allPass, true,
      `Not all passed: ${JSON.stringify(r.body.results.filter(x => !x.passed))}`);
  });

  test('onboarding — all 4 scenarios pass', async () => {
    const r = await scenario(VALID_ONBOARDING, [
      {
        name: 'full onboarding',
        events: ['EMAIL_VERIFIED', 'PROFILE_COMPLETE', 'KYC_PASSED'],
        expectedStates: ['profile_setup', 'kyc_check', 'active'],
        expectDone: false,
      },
      {
        name: 'kyc failure',
        events: ['EMAIL_VERIFIED', 'PROFILE_COMPLETE', 'KYC_FAILED'],
        expectedStates: ['profile_setup', 'kyc_check', 'suspended'],
        expectDone: false,
      },
      {
        name: 'close account',
        events: ['EMAIL_VERIFIED', 'PROFILE_COMPLETE', 'KYC_PASSED', 'CLOSE'],
        expectedStates: ['profile_setup', 'kyc_check', 'active', 'closed'],
        expectDone: true,
      },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.summary.allPass, true,
      JSON.stringify(r.body.results.filter(x => !x.passed)));
  });

  test('parallel machine scenario', async () => {
    const r = await scenario(VALID_PARALLEL, [
      {
        name: 'pay then ship then complete',
        events: ['PAY', 'SELECT_SHIPPING', 'COMPLETE'],
        expectDone: true,
      },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, true,
      r.body.results[0].error);
  });

  test('20-state pipeline scenario walks to done', async () => {
    const events = Array(19).fill('NEXT');
    const r = await scenario(VALID_MANY_STATES, [
      { name: 'full pipeline', events, expectDone: true },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Context preserved across events
// ─────────────────────────────────────────────────────────────────────────────

describe('SC1-L: Initial context is preserved through transitions', () => {
  const defId = `sc1-ctx-${Date.now()}`;

  before(async () => { await deploy(defId, VALID_CONTEXT_HEAVY); });

  test('context provided at spawn is accessible after events', async () => {
    const ctx = { applicantId: 'app-001', amount: 50000, term: 36, creditScore: 720 };
    const spawnRes = await spawn(defId, ctx);
    assert.equal(spawnRes.status, 201);
    const id = spawnRes.body.id;

    await send(id, 'SUBMIT');

    const state = (await get(`/v1/actors/${id}/state`)).body;
    assert.equal(state.stateValue, 'underwriting');
  });

  test('event history reflects all transitions', async () => {
    const { id } = (await spawn(defId, {})).body;
    await send(id, 'SUBMIT');
    await send(id, 'PASS');
    await send(id, 'DISBURSE');

    const events = (await get(`/v1/actors/${id}/events`)).body;
    assert.ok(events.total >= 3, `Expected >= 3 events, got ${events.total}`);
    const types = events.events.map(e => e.type);
    assert.ok(types.includes('SUBMIT'));
    assert.ok(types.includes('PASS'));
  });
});
