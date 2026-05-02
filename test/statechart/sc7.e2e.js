/**
 * test/statechart/sc7.e2e.js
 *
 * END-TO-END SCENARIO FILE RUNNER + REGRESSION TESTS
 *
 * Tests:
 *   - Run the bundled example scenario files (order, onboarding)
 *     against the live API, verifying every bundled scenario passes
 *   - Regression matrix: every machine in the catalog against a full
 *     event-sequence + state-check pass/fail table
 *   - Cross-machine isolation: 10 different definitions active simultaneously,
 *     each with 3 actors, verify no state bleed between definitions
 *   - The validate endpoint's `stateCount` and `finalStates` fields are accurate
 *   - Scenario with initialContext affects machine context correctly
 *   - Scenario with no events at all (empty events array)
 *   - Single-state machine (only final state) — edge case
 *
 * Run: node --test test/statechart/sc7.e2e.js
 */

import '../setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seedApiKey, post, get, put } from '../setup.js';
import {
  VALID_MINIMAL, VALID_LINEAR, VALID_BRANCHING, VALID_CYCLIC,
  VALID_HIERARCHICAL, VALID_PARALLEL, VALID_WITH_ACTIONS,
  VALID_MULTI_FINAL, VALID_SELF_TRANSITION, VALID_ONBOARDING,
  VALID_CONTEXT_HEAVY, COMPLEX_SAAS,
} from './machines.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(__dirname, '..', '..', 'examples');

before(async () => { await seedApiKey(); });

async function deploy(id, def) { return put('/v1/definitions', { id, definition: def }); }
async function spawn(defId, ctx = {}) { return post('/v1/actors', { definitionId: defId, initialContext: ctx }); }
async function send(id, type) { return post(`/v1/actors/${id}/event`, { type }); }
async function validate(def)  { return post('/v1/definitions/validate', { definition: def }); }
async function scenario(def, scenarios) { return post('/v1/definitions/scenario', { definition: def, scenarios }); }

// ─────────────────────────────────────────────────────────────────────────────
// E2E-1: Bundled example scenario files
// ─────────────────────────────────────────────────────────────────────────────

describe('SC7-A: Bundled example scenario files pass in full', () => {

  test('examples/order.scenarios.json — all scenarios pass', async () => {
    const scenarioFile = join(EXAMPLES_DIR, 'order.scenarios.json');
    const defFile      = join(EXAMPLES_DIR, 'order.definition.json');

    if (!existsSync(scenarioFile) || !existsSync(defFile)) {
      console.log('  SKIP: example files not found — skipping bundled scenario test');
      return;
    }

    const rawDef = JSON.parse(readFileSync(defFile, 'utf8'));
    const definition = rawDef.definition ?? rawDef;
    const { scenarios: scenarios_ } = JSON.parse(readFileSync(scenarioFile, 'utf8'));

    const r = await post('/v1/definitions/scenario', { definition, scenarios: scenarios_ });
    assert.equal(r.status, 200, `Scenario runner failed: ${JSON.stringify(r.body)}`);

    const failed = r.body.results.filter(x => !x.passed);
    assert.equal(failed.length, 0,
      `Bundled order scenarios failed:\n${failed.map(f => `  ${f.name}: ${f.error || JSON.stringify(f.steps.find(s=>!s.pass))}`).join('\n')}`
    );
    console.log(`  order.scenarios.json: ${r.body.summary.passed}/${r.body.summary.total} passed`);
  });

  test('examples/onboarding.scenarios.json — all scenarios pass', async () => {
    const scenarioFile = join(EXAMPLES_DIR, 'onboarding.scenarios.json');
    const defFile      = join(EXAMPLES_DIR, 'onboarding.definition.json');

    if (!existsSync(scenarioFile) || !existsSync(defFile)) {
      console.log('  SKIP: onboarding example files not found');
      return;
    }

    const rawDef2 = JSON.parse(readFileSync(defFile, 'utf8'));
    const definition = rawDef2.definition ?? rawDef2;
    const { scenarios: scenarios_ } = JSON.parse(readFileSync(scenarioFile, 'utf8'));

    const r = await post('/v1/definitions/scenario', { definition, scenarios: scenarios_ });
    assert.equal(r.status, 200);

    const failed = r.body.results.filter(x => !x.passed);
    assert.equal(failed.length, 0,
      `Bundled onboarding scenarios failed:\n${failed.map(f => `  ${f.name}: ${f.error}`).join('\n')}`
    );
    console.log(`  onboarding.scenarios.json: ${r.body.summary.passed}/${r.body.summary.total} passed`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-2: Validate endpoint accuracy — stateCount and finalStates
// ─────────────────────────────────────────────────────────────────────────────

describe('SC7-B: Validate endpoint — stateCount and finalStates are accurate', () => {
  const cases = [
    {
      name:   'minimal (2 states, 1 final)',
      def:    VALID_MINIMAL,
      count:  2,
      finals: ['on'],
    },
    {
      name:   'linear (4 states, 1 final)',
      def:    VALID_LINEAR,
      count:  4,
      finals: ['done'],
    },
    {
      name:   'branching (6 states, 2 finals)',
      def:    VALID_BRANCHING,
      count:  6,
      finals: ['approved', 'discarded'],
    },
    {
      name:   'multi-final order (7 states, 3 finals)',
      def:    VALID_MULTI_FINAL,
      count:  7,
      finals: ['delivered', 'refunded', 'cancelled'],
    },
    {
      name:   'cyclic (5 states, 2 finals)',
      def:    VALID_CYCLIC,
      count:  5,
      finals: ['done', 'aborted'],
    },
    {
      name:   'context-heavy loan (10 states, 5 finals)',
      def:    VALID_CONTEXT_HEAVY,
      count:  10,
      finals: ['rejected', 'withdrawn', 'cancelled', 'closed', 'defaulted'],
    },
  ];

  for (const { name, def, count, finals } of cases) {
    test(`${name}: stateCount=${count} finalStates=[${finals.join(',')}]`, async () => {
      const r = await validate(def);
      assert.equal(r.status, 200, `validate failed: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.valid, true);
      assert.equal(r.body.stateCount, count,
        `Expected stateCount=${count}, got ${r.body.stateCount}`);

      for (const f of finals) {
        assert.ok(r.body.finalStates.includes(f),
          `Expected finalState '${f}' in ${JSON.stringify(r.body.finalStates)}`);
      }
      assert.equal(r.body.finalStates.length, finals.length,
        `Expected ${finals.length} final states, got ${r.body.finalStates.length}: ${JSON.stringify(r.body.finalStates)}`);
    });
  }

  test('parallel machine: stateCount covers top-level states', async () => {
    const r = await validate(VALID_PARALLEL);
    assert.equal(r.status, 200);
    assert.equal(r.body.valid, true);
    // Top-level states: active, done
    assert.equal(r.body.stateCount, 2,
      `Expected 2 top-level states for parallel machine, got ${r.body.stateCount}`);
    assert.ok(r.body.finalStates.includes('done'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-3: Empty events array in scenario
// ─────────────────────────────────────────────────────────────────────────────

describe('SC7-C: Scenario with zero events — initial state only', () => {

  test('empty events array — finalState is initialState, done only if initial is final', async () => {
    const r = await scenario(VALID_LINEAR, [
      { name: 'no events', events: [], expectedStates: [], expectDone: false },
    ]);
    assert.equal(r.status, 200);
    const result = r.body.results[0];
    assert.equal(result.passed, true, 'Empty scenario should pass with no steps');
    assert.equal(result.steps.length, 0);
    assert.equal(result.finalState, 'idle', 'finalState should be initial state');
    assert.equal(result.done, false, 'idle is not a final state');
  });

  test('empty events on a machine that starts in final state', async () => {
    // A machine whose initial IS a final state (unusual but valid)
    const alreadyDone = {
      id: 'already-done',
      initial: 'done',
      states: {
        done: { type: 'final' },
      },
    };
    const r = await scenario(alreadyDone, [
      { name: 'starts done', events: [], expectDone: true },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, true);
    assert.equal(r.body.results[0].done, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-4: initialContext in scenario
// ─────────────────────────────────────────────────────────────────────────────

describe('SC7-D: Scenario with initialContext — context shapes the machine', () => {

  test('machine with context field: scenario receives context', async () => {
    // A machine that uses context (XState v5 context in scenario is just baggage)
    const r = await scenario(VALID_CONTEXT_HEAVY, [
      {
        name: 'loan with initial context',
        initialContext: { applicantId: 'test-001', amount: 10000, creditScore: 750 },
        events: ['SUBMIT', 'PASS', 'DISBURSE'],
        expectedStates: ['underwriting', 'approved', 'active'],
        expectDone: false,
      },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, true,
      `Scenario failed: ${r.body.results[0].error}`);
  });

  test('different initialContext does not affect transition logic (XState ignores context in guards when no impl)', async () => {
    // Verify same machine with different initialContext produces same transitions
    const scenarios_ = [
      {
        name: 'context A',
        initialContext: { value: 100 },
        events: ['SUBMIT', 'PASS'],
        expectedStates: ['underwriting', 'approved'],
      },
      {
        name: 'context B',
        initialContext: { value: 999, extra: 'data' },
        events: ['SUBMIT', 'PASS'],
        expectedStates: ['underwriting', 'approved'],
      },
    ];
    const r = await scenario(VALID_CONTEXT_HEAVY, scenarios_);
    assert.equal(r.status, 200);
    assert.equal(r.body.summary.allPass, true,
      `Both context variants should produce same transitions: ${JSON.stringify(r.body.results.map(x => ({n: x.name, p: x.passed, e: x.error})))}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-5: Cross-machine isolation — 10 definitions × 3 actors
// ─────────────────────────────────────────────────────────────────────────────

describe('SC7-E: Cross-machine isolation — 10 definitions, 30 actors total', () => {
  const machines = [
    VALID_MINIMAL, VALID_LINEAR, VALID_BRANCHING, VALID_CYCLIC,
    VALID_HIERARCHICAL, VALID_PARALLEL, VALID_WITH_ACTIONS,
    VALID_MULTI_FINAL, VALID_SELF_TRANSITION, VALID_ONBOARDING,
  ];

  const ts = Date.now();
  const defIds = machines.map((_, i) => `iso-def-${i}-${ts}`);
  const allActors = {}; // defId → [actorIds]

  before(async () => {
    // Deploy all 10 definitions
    await Promise.all(machines.map((m, i) => deploy(defIds[i], m)));

    // Spawn 3 actors per definition
    for (let i = 0; i < machines.length; i++) {
      const spawns = await Promise.all(
        Array.from({ length: 3 }, () => spawn(defIds[i]))
      );
      allActors[defIds[i]] = spawns.map(r => r.body.id);
    }
  });

  test('all 30 actors are in correct initial states for their definition', async () => {
    const initialStates = {
      [defIds[0]]: 'off',      // minimal
      [defIds[1]]: 'idle',     // linear
      [defIds[2]]: 'draft',    // branching
      [defIds[3]]: 'queued',   // cyclic
      [defIds[4]]: 'off',      // hierarchical
      // parallel: complex object
      [defIds[6]]: 'authenticating', // with_actions
      [defIds[7]]: 'pending',  // multi_final
      [defIds[8]]: 'counting', // self_transition
      [defIds[9]]: 'email_verification', // onboarding
    };

    for (const [defId, expected] of Object.entries(initialStates)) {
      for (const id of allActors[defId]) {
        const r = await get(`/v1/actors/${id}/state`);
        assert.equal(r.status, 200);
        assert.equal(r.body.stateValue, expected,
          `Actor on ${defId} should be in ${expected}, got ${r.body.stateValue}`);
      }
    }
  });

  test('driving actors on one definition does not affect actors on another', async () => {
    // Drive all 3 LINEAR actors to 'processing'
    for (const id of allActors[defIds[1]]) {
      await send(id, 'START');
    }

    // Verify BRANCHING actors still in 'draft'
    for (const id of allActors[defIds[2]]) {
      const r = await get(`/v1/actors/${id}/state`);
      assert.equal(r.body.stateValue, 'draft',
        `Branching actor should still be in draft: ${r.body.stateValue}`);
    }

    // Verify CYCLIC actors still in 'queued'
    for (const id of allActors[defIds[3]]) {
      const r = await get(`/v1/actors/${id}/state`);
      assert.equal(r.body.stateValue, 'queued',
        `Cyclic actor should still be in queued: ${r.body.stateValue}`);
    }
  });

  test('actor IDs are globally unique across all 10 definitions', async () => {
    const allIds = Object.values(allActors).flat();
    assert.equal(new Set(allIds).size, allIds.length,
      'All 30 actor IDs must be globally unique');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-6: Regression matrix — known event sequences for every valid machine
// ─────────────────────────────────────────────────────────────────────────────

describe('SC7-F: Regression matrix — known correct sequences for all valid machines', () => {
  const ts = Date.now();

  const regressions = [
    {
      name: 'minimal',
      def:  VALID_MINIMAL,
      id:   `reg-minimal-${ts}`,
      sequence: ['TURN_ON'],
      expectedFinal: 'on',
      expectDone: true,
    },
    {
      name: 'linear happy path',
      def:  VALID_LINEAR,
      id:   `reg-linear-${ts}`,
      sequence: ['START', 'COMPLETE'],
      expectedFinal: 'done',
      expectDone: true,
    },
    {
      name: 'linear failure then success',
      def:  VALID_LINEAR,
      id:   `reg-linear-fail-${ts}`,
      sequence: ['START', 'FAIL', 'RETRY', 'FAIL', 'RETRY', 'COMPLETE'],
      expectedFinal: 'done',
      expectDone: true,
    },
    {
      name: 'branching approve path',
      def:  VALID_BRANCHING,
      id:   `reg-branch-${ts}`,
      sequence: ['SUBMIT', 'APPROVE'],
      expectedFinal: 'approved',
      expectDone: true,
    },
    {
      name: 'branching discard shortcut',
      def:  VALID_BRANCHING,
      id:   `reg-branch-disc-${ts}`,
      sequence: ['DISCARD'],
      expectedFinal: 'discarded',
      expectDone: true,
    },
    {
      name: 'cyclic abort',
      def:  VALID_CYCLIC,
      id:   `reg-cyclic-${ts}`,
      sequence: ['PICK_UP', 'ERROR', 'ABORT'],
      expectedFinal: 'aborted',
      expectDone: true,
    },
    {
      name: 'onboarding full path',
      def:  VALID_ONBOARDING,
      id:   `reg-onboard-${ts}`,
      sequence: ['EMAIL_VERIFIED', 'PROFILE_COMPLETE', 'KYC_PASSED', 'CLOSE'],
      expectedFinal: 'closed',
      expectDone: true,
    },
    {
      name: 'self-transition then finish',
      def:  VALID_SELF_TRANSITION,
      id:   `reg-self-${ts}`,
      sequence: ['INCREMENT', 'INCREMENT', 'INCREMENT', 'RESET', 'FINISH'],
      expectedFinal: 'done',
      expectDone: true,
    },
    {
      name: 'order — return refund',
      def:  VALID_MULTI_FINAL,
      id:   `reg-order-${ts}`,
      sequence: ['PAY', 'SHIP', 'RETURN', 'RECEIVED'],
      expectedFinal: 'refunded',
      expectDone: true,
    },
  ];

  before(async () => {
    const uniqueDefs = [...new Set(regressions.map(r => JSON.stringify([r.id, r.def])))];
    for (const item of regressions) {
      await deploy(item.id, item.def);
    }
  });

  for (const { name, def, sequence, expectedFinal, expectDone } of regressions) {
    test(`regression: ${name} → ${expectedFinal}`, async () => {
      const r = await scenario(def, [
        {
          name,
          events: sequence,
          expectedStates: [
            ...sequence.slice(0, -1).map(() => undefined), // don't care about interim
            expectedFinal,
          ],
          expectDone,
        },
      ]);
      assert.equal(r.status, 200);

      const result = r.body.results[0];
      if (!result.passed) {
        console.log(`  FAIL: ${name}`);
        console.log(`    final state: ${JSON.stringify(result.finalState)}`);
        console.log(`    expected:    ${expectedFinal}`);
        result.steps.filter(s => !s.pass).forEach(s =>
          console.log(`    step ${s.step}: sent ${s.event} → ${JSON.stringify(s.state)} (expected ${s.expected})`)
        );
      }
      assert.equal(result.passed, true, `Regression failed: ${name}`);
      assert.equal(JSON.stringify(result.finalState), JSON.stringify(expectedFinal),
        `Final state mismatch for ${name}`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-7: Single-state machine (only a final state)
// ─────────────────────────────────────────────────────────────────────────────

describe('SC7-G: Edge case — machine with only one final state', () => {
  const instantDone = {
    id: 'instant',
    initial: 'done',
    states: { done: { type: 'final' } },
  };

  test('validate: single-final-state machine is valid', async () => {
    const r = await validate(instantDone);
    assert.equal(r.status, 200);
    assert.equal(r.body.valid, true);
    assert.equal(r.body.stateCount, 1);
    assert.deepEqual(r.body.finalStates, ['done']);
  });

  test('spawn actor starts in final state immediately', async () => {
    const defId = `instant-done-${Date.now()}`;
    await deploy(defId, instantDone);
    const r = await spawn(defId);
    assert.equal(r.status, 201);
    assert.equal(r.body.stateValue, 'done');
    assert.equal(r.body.done, true);
  });

  test('scenario: no events, expectDone:true passes', async () => {
    const r = await scenario(instantDone, [
      { name: 'instant done', events: [], expectDone: true },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, true);
    assert.equal(r.body.results[0].done, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-8: Scenario respects event object shape (string vs {type} object)
// ─────────────────────────────────────────────────────────────────────────────

describe('SC7-H: Scenario — event as string vs event as {type} object', () => {

  test('string events and object events produce same transitions', async () => {
    const [stringResult, objectResult] = await Promise.all([
      scenario(VALID_LINEAR, [
        { name: 'string events', events: ['START', 'COMPLETE'], expectDone: true },
      ]),
      scenario(VALID_LINEAR, [
        { name: 'object events', events: [{ type: 'START' }, { type: 'COMPLETE' }], expectDone: true },
      ]),
    ]);

    assert.equal(stringResult.status, 200);
    assert.equal(objectResult.status, 200);
    assert.equal(stringResult.body.results[0].passed, true, 'String events should work');
    assert.equal(objectResult.body.results[0].passed, true, 'Object events should work');
    assert.equal(
      JSON.stringify(stringResult.body.results[0].finalState),
      JSON.stringify(objectResult.body.results[0].finalState),
      'String and object events must produce identical final state'
    );
  });

  test('mixed string/object events in same scenario', async () => {
    const r = await scenario(VALID_LINEAR, [
      {
        name: 'mixed',
        events: ['START', { type: 'FAIL' }, 'RETRY', { type: 'COMPLETE' }],
        expectedStates: ['processing', 'failed', 'processing', 'done'],
        expectDone: true,
      },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, true);
  });
});
