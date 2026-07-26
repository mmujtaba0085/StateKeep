/**
 * test/statechart/sc3.stuck.js
 *
 * LOGICALLY STUCK MACHINES
 *
 * These machines are structurally valid JSON that XState will happily
 * create — but they contain logical flaws that trap actors at runtime:
 *   dead-end states, unreachable states, no terminal path, pure self-loops,
 *   missing events, and guard names without implementations.
 *
 * For each machine this file tests:
 *   1. validate endpoint — does it catch the logical flaw? (often: NO — gap)
 *   2. spawn succeeds (machine is structurally fine)
 *   3. Driving into the trap — actor gets stuck
 *   4. What the system does / should do about it
 *
 * Tests labelled [EXPECTED-PASS] will always pass under the current system.
 * Tests labelled [GAP] document current system limitations.
 *
 * Run: node --test test/statechart/sc3.stuck.js
 */

import '../setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { seedApiKey, post, get, put } from '../setup.js';
import {
  STUCK_DEAD_END,
  STUCK_UNREACHABLE,
  STUCK_NO_TERMINAL,
  STUCK_SELF_LOOP_ONLY,
  STUCK_MISSING_EVENT,
  STUCK_GUARD_NO_IMPL,
} from './machines.js';

before(async () => { await seedApiKey(); });

async function validate(def) { return post('/v1/definitions/validate', { definition: def }); }
async function deploy(id, def) { return put('/v1/definitions', { id, definition: def }); }
async function spawn(definitionId) { return post('/v1/actors', { definitionId }); }
async function send(id, type) { return post(`/v1/actors/${id}/event`, { type }); }
async function scenario(def, scenarios) { return post('/v1/definitions/scenario', { definition: def, scenarios }); }

// ─────────────────────────────────────────────────────────────────────────────
// S1: Dead-end state — non-final, zero outgoing transitions
// ─────────────────────────────────────────────────────────────────────────────

describe('SC3-A: Dead-end state (trapped — non-final, no exits)', () => {

  test('[GAP] validate does NOT detect dead-end (XState accepts it)', async () => {
    const r = await validate(STUCK_DEAD_END);
    // XState creates the machine fine — no runtime check for dead-ends at definition time
    // The validate endpoint will return valid:true — this is the gap
    console.log(`  validate dead-end: ${r.status} valid:${r.body.valid}`);
    if (r.body.valid === true) {
      console.log('  [GAP] Platform did not detect dead-end state "trapped"');
    }
    assert.ok([200, 400].includes(r.status), `Unexpected status: ${r.status}`);
  });

  test('[EXPECTED-PASS] spawn succeeds — machine is structurally valid', async () => {
    const defId = `stuck-dead-end-${Date.now()}`;
    await deploy(defId, STUCK_DEAD_END);
    const r = await spawn(defId);
    assert.equal(r.status, 201);
    assert.equal(r.body.stateValue, 'start');
  });

  test('[EXPECTED-PASS] GO drives actor into dead-end "trapped"', async () => {
    const defId = `stuck-dead-end-events-${Date.now()}`;
    await deploy(defId, STUCK_DEAD_END);
    const { id } = (await spawn(defId)).body;

    const r = await send(id, 'GO');
    assert.equal(r.status, 200);
    assert.equal(r.body.stateValue, 'trapped');
    assert.equal(r.body.done, false, 'trapped is NOT a final state');
  });

  test('[GAP] Events in dead-end state are silently ignored (no error, no progress)', async () => {
    const defId = `stuck-dead-end-stuck-${Date.now()}`;
    await deploy(defId, STUCK_DEAD_END);
    const { id } = (await spawn(defId)).body;

    await send(id, 'GO'); // → trapped

    // Try 5 different events — all ignored, actor stays in trapped
    for (const evt of ['START', 'DONE', 'EXIT', 'ESCAPE', 'HELP']) {
      const r = await send(id, evt);
      assert.equal(r.status, 200);
      assert.equal(r.body.stateValue, 'trapped',
        `Expected to remain in trapped after ${evt}, got: ${r.body.stateValue}`);
    }
    // [GAP] System has no way to detect or report this; actor is silently stuck
    console.log('  [GAP] Actor stuck in dead-end with no mechanism to escape or alert');
  });

  test('[GAP] scenario runner flags trapped path as failed (expectDone:true)', async () => {
    const r = await scenario(STUCK_DEAD_END, [
      {
        name: 'drive to trapped and expect done — should FAIL',
        events: ['GO'],
        expectedStates: ['trapped'],
        expectDone: true,  // trapped is NOT final — this scenario should fail
      },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, false,
      'Scenario expecting done from dead-end state MUST report as failed');
    assert.ok(r.body.results[0].error,
      'Error message must explain why done was expected but not reached');
    console.log(`  Scenario error: ${r.body.results[0].error}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S2: Unreachable state
// ─────────────────────────────────────────────────────────────────────────────

describe('SC3-B: Unreachable state — exists in definition but no path leads there', () => {

  test('[GAP] validate reports valid (XState has no reachability analysis)', async () => {
    const r = await validate(STUCK_UNREACHABLE);
    console.log(`  validate unreachable: valid:${r.body.valid}`);
    // Current gap: no static reachability check
    assert.ok([200, 400].includes(r.status));
  });

  test('[EXPECTED-PASS] spawn succeeds', async () => {
    const defId = `stuck-unreachable-${Date.now()}`;
    await deploy(defId, STUCK_UNREACHABLE);
    const r = await spawn(defId);
    assert.equal(r.status, 201);
    assert.equal(r.body.stateValue, 'a');
  });

  test('[EXPECTED-PASS] actor never visits "unreachable" via any valid event', async () => {
    const defId = `stuck-unreach-events-${Date.now()}`;
    await deploy(defId, STUCK_UNREACHABLE);
    const { id } = (await spawn(defId)).body;

    // All valid events from a → b (final)
    const r1 = await send(id, 'GO');
    assert.equal(r1.body.stateValue, 'b');

    // ESCAPE would move from unreachable → b, but we can never GET there
    // Sending ESCAPE from b is a no-op
    const r2 = await send(id, 'ESCAPE');
    assert.equal(r2.body.stateValue, 'b', 'ESCAPE from b does nothing');
  });

  test('[GAP] scenario reveals unreachable state cannot be tested (no path to it)', async () => {
    const r = await scenario(STUCK_UNREACHABLE, [
      {
        name: 'try to reach unreachable via ESCAPE from start',
        events: ['ESCAPE'],              // ESCAPE not defined on state 'a'
        expectedStates: ['unreachable'], // won't work — state 'a' has no ESCAPE
        expectDone: false,
      },
    ]);
    assert.equal(r.status, 200);
    // Step should fail: ESCAPE from 'a' is ignored, state stays 'a' not 'unreachable'
    const step = r.body.results[0].steps[0];
    assert.equal(step.pass, false,
      'Scenario targeting unreachable state should report step failure');
    console.log(`  Unreachable step result — state: ${step.state}, expected: ${step.expected}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S3: No terminal state — machine loops forever
// ─────────────────────────────────────────────────────────────────────────────

describe('SC3-C: No terminal path — machine has no final states', () => {

  test('[GAP] validate returns valid (XState allows machines with no final states)', async () => {
    const r = await validate(STUCK_NO_TERMINAL);
    console.log(`  validate no-terminal: valid:${r.body.valid}`);
    // XState v5 allows machines with no final states — this is valid for long-lived actors
    // but in StateKeep context, an actor that can NEVER be done is a resource concern
    assert.ok([200, 400].includes(r.status));
  });

  test('[EXPECTED-PASS] spawn + transitions work', async () => {
    const defId = `stuck-no-terminal-${Date.now()}`;
    await deploy(defId, STUCK_NO_TERMINAL);
    const { id } = (await spawn(defId)).body;

    await send(id, 'GO');
    const r = await send(id, 'BACK');
    assert.equal(r.body.stateValue, 'a');
    assert.equal(r.body.done, false);
  });

  test('[GAP] actor can never reach done state (expectDone:true always fails)', async () => {
    const r = await scenario(STUCK_NO_TERMINAL, [
      {
        name: 'GO then BACK — never done',
        events: ['GO', 'BACK', 'GO', 'BACK'],
        expectDone: true,  // IMPOSSIBLE — no final state
      },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, false,
      'Machine with no final states can never satisfy expectDone:true');
    assert.ok(r.body.results[0].error, 'Error must explain the issue');
    console.log(`  No-terminal error: ${r.body.results[0].error}`);
  });

  test('[EXPECTED-PASS] 1000 events on no-terminal machine — system stays stable', async () => {
    const defId = `stuck-no-terminal-1k-${Date.now()}`;
    await deploy(defId, STUCK_NO_TERMINAL);
    const { id } = (await spawn(defId)).body;

    // Rapidly alternate GO / BACK 500 times (1000 events total)
    let lastState;
    for (let i = 0; i < 500; i++) {
      await send(id, 'GO');
      const r = await send(id, 'BACK');
      lastState = r.body.stateValue;
    }
    assert.equal(lastState, 'a', 'Should end in "a" after even number of cycles');

    // Actor must still be queryable
    const state = (await get(`/v1/actors/${id}/state`)).body;
    assert.ok(state.stateValue, 'Actor must be accessible after 1000 events');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S4: Self-loop only — done is unreachable
// ─────────────────────────────────────────────────────────────────────────────

describe('SC3-D: Self-loop only machine — "done" is unreachable', () => {

  test('[EXPECTED-PASS] validate accepts it (valid structure)', async () => {
    const r = await validate(STUCK_SELF_LOOP_ONLY);
    // Valid JSON machine — XState accepts self-loops
    assert.ok([200, 400].includes(r.status));
  });

  test('[EXPECTED-PASS] SPIN events loop indefinitely', async () => {
    const defId = `stuck-self-loop-${Date.now()}`;
    await deploy(defId, STUCK_SELF_LOOP_ONLY);
    const { id } = (await spawn(defId)).body;

    for (let i = 0; i < 50; i++) {
      const r = await send(id, 'SPIN');
      assert.equal(r.body.stateValue, 'spinning', `Failed at spin ${i}`);
    }
  });

  test('[GAP] "done" state is defined but can never be reached', async () => {
    const r = await scenario(STUCK_SELF_LOOP_ONLY, [
      {
        name: 'try to reach done — impossible',
        events: ['SPIN', 'SPIN', 'SPIN'],
        expectedStates: ['spinning', 'spinning', 'done'],  // 3rd step will fail
        expectDone: true,
      },
    ]);
    assert.equal(r.status, 200);
    const result = r.body.results[0];
    assert.equal(result.passed, false, 'Should fail — done is unreachable via SPIN');
    // The 3rd step (expected: 'done') should report fail
    const failedStep = result.steps.find(s => !s.pass);
    assert.ok(failedStep, 'At least one step should have failed');
    console.log(`  Self-loop stuck step: event=${failedStep.event} state=${failedStep.state} expected=${failedStep.expected}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S5: Missing event — scenario sends wrong event
// ─────────────────────────────────────────────────────────────────────────────

describe('SC3-E: Missing event — machine only handles WAKE, scenario sends START', () => {

  test('[EXPECTED-PASS] spawn and correct event works', async () => {
    const defId = `stuck-missing-evt-${Date.now()}`;
    await deploy(defId, STUCK_MISSING_EVENT);
    const { id } = (await spawn(defId)).body;

    const r = await send(id, 'WAKE');
    assert.equal(r.body.stateValue, 'done');
    assert.equal(r.body.done, true);
  });

  test('[EXPECTED-PASS] wrong event is silently ignored (state stays "waiting")', async () => {
    const defId = `stuck-wrong-evt-${Date.now()}`;
    await deploy(defId, STUCK_MISSING_EVENT);
    const { id } = (await spawn(defId)).body;

    for (const evt of ['START', 'GO', 'RUN', 'BEGIN', 'TRIGGER']) {
      const r = await send(id, evt);
      assert.equal(r.body.stateValue, 'waiting',
        `Expected waiting after ignored ${evt}, got: ${r.body.stateValue}`);
    }
  });

  test('[EXPECTED-PASS] scenario with wrong event reports step failure', async () => {
    const r = await scenario(STUCK_MISSING_EVENT, [
      {
        name: 'send START (wrong event) — should stay in waiting',
        events: ['START'],
        expectedStates: ['done'],  // WRONG expectation — won't transition
        expectDone: true,
      },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, false,
      'Scenario with wrong event must report failure');
    const step = r.body.results[0].steps[0];
    assert.equal(step.pass, false);
    assert.equal(step.state, 'waiting', 'State must still be waiting');
    assert.equal(step.expected, 'done');
    console.log(`  Missing-event step: sent=${step.event} landed=${step.state} expected=${step.expected}`);
  });

  test('[EXPECTED-PASS] scenario with correct WAKE event passes', async () => {
    const r = await scenario(STUCK_MISSING_EVENT, [
      {
        name: 'correct WAKE event',
        events: ['WAKE'],
        expectedStates: ['done'],
        expectDone: true,
      },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].passed, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S6: Guard name without implementation
// ─────────────────────────────────────────────────────────────────────────────

describe('SC3-F: Guard name without implementation — XState v5 behaviour', () => {

  test('[EXPECTED-PASS] validate accepts guard names (implementations are runtime concern)', async () => {
    const r = await validate(STUCK_GUARD_NO_IMPL);
    console.log(`  guard-no-impl validate: ${r.status} valid:${r.body.valid}`);
    // XState v5 accepts guard names at definition time
    assert.ok([200, 400].includes(r.status));
  });

  test('[EXPECTED-PASS] spawn succeeds', async () => {
    const defId = `stuck-guard-${Date.now()}`;
    await deploy(defId, STUCK_GUARD_NO_IMPL);
    const r = await spawn(defId);
    assert.equal(r.status, 201);
    assert.equal(r.body.stateValue, 'check');
  });

  test('[EXPECTED-PASS] EVALUATE with unimplemented guard: first matching target is taken', async () => {
    // XState v5 with no guard implementation: unresolved guard = false
    // So [{ guard: 'isEligible', target: 'pass' }, { target: 'fail' }]
    // isEligible is not implemented → treated as false → skip to next → 'fail'
    const defId = `stuck-guard-eval-${Date.now()}`;
    await deploy(defId, STUCK_GUARD_NO_IMPL);
    const { id } = (await spawn(defId)).body;

    const r = await send(id, 'EVALUATE');
    assert.equal(r.status, 200);
    // Document what actually happens — either pass (guard is truthy no-op) or fail
    console.log(`  EVALUATE with no-impl guard → stateValue: ${r.body.stateValue}`);
    assert.ok(['pass', 'fail'].includes(r.body.stateValue),
      `Expected pass or fail, got: ${r.body.stateValue}`);
  });

  test('[EXPECTED-PASS] scenario captures actual guard behaviour', async () => {
    const r = await scenario(STUCK_GUARD_NO_IMPL, [
      {
        name: 'EVALUATE goes to pass (if guard is no-op truthy)',
        events: ['EVALUATE'],
        expectedStates: ['pass'],
        expectDone: true,
      },
      {
        name: 'EVALUATE goes to fail (if guard is no-op falsy)',
        events: ['EVALUATE'],
        expectedStates: ['fail'],
        expectDone: true,
      },
    ]);
    assert.equal(r.status, 200);
    // Exactly one of the two scenarios should pass (depends on XState v5 guard semantics)
    const passed = r.body.results.filter(r => r.passed).length;
    assert.equal(passed, 1,
      `Expected exactly 1 of 2 guard scenarios to pass, got ${passed}: ${JSON.stringify(r.body.results)}`);
    console.log(`  Guard outcome: ${r.body.results.map(r => `${r.name}=${r.passed}`).join(', ')}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S7: Combined — mixed valid and stuck scenarios in one scenario batch
// ─────────────────────────────────────────────────────────────────────────────

describe('SC3-G: Mixed batch — some scenarios pass, some fail', () => {

  test('order machine: 2 pass, 1 fails (wrong expectation)', async () => {
    const { VALID_MULTI_FINAL } = await import('./machines.js');
    const r = await scenario(VALID_MULTI_FINAL, [
      {
        name: 'correct happy path — PASS',
        events: ['PAY', 'SHIP', 'DELIVER'],
        expectedStates: ['paid', 'shipped', 'delivered'],
        expectDone: true,
      },
      {
        name: 'cancel — PASS',
        events: ['CANCEL'],
        expectedStates: ['cancelled'],
        expectDone: true,
      },
      {
        name: 'wrong expectation — FAIL (expects delivered but goes to paid)',
        events: ['PAY'],
        expectedStates: ['delivered'],  // WRONG — PAY goes to paid, not delivered
        expectDone: false,
      },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.summary.passed, 2, `Expected 2 passed, got ${r.body.summary.passed}`);
    assert.equal(r.body.summary.failed, 1, `Expected 1 failed, got ${r.body.summary.failed}`);
    assert.equal(r.body.summary.allPass, false);

    const failedResult = r.body.results.find(x => !x.passed);
    assert.ok(failedResult, 'Should have one failed result');
    assert.equal(failedResult.steps[0].state, 'paid');
    assert.equal(failedResult.steps[0].expected, 'delivered');
  });

  test('5 scenarios: 3 correct, 2 intentionally wrong', async () => {
    const { VALID_ONBOARDING } = await import('./machines.js');
    const r = await scenario(VALID_ONBOARDING, [
      {
        name: 'S1: correct verification path — PASS',
        events: ['EMAIL_VERIFIED', 'PROFILE_COMPLETE', 'KYC_PASSED'],
        expectedStates: ['profile_setup', 'kyc_check', 'active'],
        expectDone: false,
      },
      {
        name: 'S2: skip email — PASS',
        events: ['SKIP', 'PROFILE_COMPLETE', 'KYC_PASSED'],
        expectedStates: ['profile_setup', 'kyc_check', 'active'],
        expectDone: false,
      },
      {
        name: 'S3: full closure — PASS',
        events: ['EMAIL_VERIFIED', 'PROFILE_COMPLETE', 'KYC_PASSED', 'CLOSE'],
        expectedStates: ['profile_setup', 'kyc_check', 'active', 'closed'],
        expectDone: true,
      },
      {
        name: 'S4: wrong event order — FAIL',
        events: ['PROFILE_COMPLETE', 'EMAIL_VERIFIED'],  // Can't go directly to PROFILE_COMPLETE
        expectedStates: ['kyc_check', 'active'],          // Wrong — stays in email_verification
        expectDone: false,
      },
      {
        name: 'S5: expects done but machine not in final state — FAIL',
        events: ['EMAIL_VERIFIED', 'PROFILE_COMPLETE', 'KYC_PASSED'],
        expectedStates: ['profile_setup', 'kyc_check', 'active'],
        expectDone: true,  // WRONG — 'active' is not final
      },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.summary.passed, 3, `Expected 3 passed: ${JSON.stringify(r.body.results.map(x => ({n: x.name, p: x.passed})))}`);
    assert.equal(r.body.summary.failed, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S8: Scenario step-level assertion granularity
// ─────────────────────────────────────────────────────────────────────────────

describe('SC3-H: Step-level granularity in scenario results', () => {

  test('early failure in sequence — runner stops at final state', async () => {
    const { VALID_LINEAR } = await import('./machines.js');
    const r = await scenario(VALID_LINEAR, [
      {
        name: 'step 1 correct, step 2 wrong, step 3 correct',
        events: ['START', 'COMPLETE', 'RETRY'],
        expectedStates: ['processing', 'wrong_state', 'done'], // step 2 is wrong
        expectDone: false,
      },
    ]);
    assert.equal(r.status, 200);
    const result = r.body.results[0];
    assert.equal(result.passed, false);

    // Step 1: START → processing (correct)
    assert.equal(result.steps[0].pass, true, 'Step 1 should pass');
    assert.equal(result.steps[0].state, 'processing');

    // Step 2: COMPLETE → done (wrong expectation: expected 'wrong_state')
    assert.equal(result.steps[1].pass, false, 'Step 2 should fail');
    assert.equal(result.steps[1].state, 'done');
    assert.equal(result.steps[1].expected, 'wrong_state');

    // Step 3: Machine reached final state after step 2 — runner stops before processing step 3
    assert.equal(result.steps.length, 2, 'Runner stops at final state — step 3 not executed');
  });

  test('expectDone:false + machine IS done → FAIL (both directions now enforced)', async () => {
    // The runner now enforces expectDone in both directions:
    //   expectDone:true  + not done → fail  (existing behaviour)
    //   expectDone:false + IS done  → fail  (newly fixed)
    const { VALID_LINEAR } = await import('./machines.js');
    const r = await scenario(VALID_LINEAR, [
      {
        name: 'expectDone:false but reaches final state',
        events: ['START', 'COMPLETE'],
        expectedStates: ['processing', 'done'],
        expectDone: false,  // machine IS done — runner now correctly fails this
      },
    ]);
    assert.equal(r.status, 200);
    const result = r.body.results[0];
    // FIXED: runner now fails when expectDone:false && machine IS done
    assert.equal(result.passed, false,
      `Expected passed:false when expectDone:false but machine reaches done, got: passed:${result.passed}`);
    assert.equal(result.done, true, 'Machine should report done:true');
    assert.ok(result.error?.includes('expectDone:false'),
      `Error should explain the expectDone:false enforcement: ${result.error}`);
    console.log(`  FIXED: expectDone:false + isDone → passed:${result.passed}, error: ${result.error}`);
  });
});
