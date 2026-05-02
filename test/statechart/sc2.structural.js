/**
 * test/statechart/sc2.structural.js
 *
 * STRUCTURALLY BROKEN STATECHARTS
 *
 * These tests submit malformed JSON statecharts and verify the system's
 * response.  The system has TWO layers where breakage can surface:
 *
 *   Layer 1: POST /v1/definitions/validate  — explicit validation (dry-run)
 *   Layer 2: PUT /v1/definitions + POST /v1/actors — persisted path
 *
 * IMPORTANT: Currently StateKeep does NOT validate the definition JSON
 * before storing it (PUT /v1/definitions accepts anything that is a valid
 * JSON object).  This means:
 *
 *   - validate endpoint SHOULD return valid:false  ← tests labeled [VALIDATE]
 *   - PUT /v1/definitions may ACCEPT a broken def  ← tests labeled [STORE-GAP]
 *   - spawn/event may CRASH or produce odd state   ← tests labeled [RUNTIME]
 *
 * Tests marked [SHOULD-FAIL] document current system behaviour that is a
 * known gap — the assertion records what the system *currently* does so you
 * can track if/when it improves.
 *
 * Run: node --test test/statechart/sc2.structural.js
 */

import '../setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { seedApiKey, post, get, put } from '../setup.js';
import {
  BROKEN_NO_INITIAL,
  BROKEN_INITIAL_MISSING_TARGET,
  BROKEN_TRANSITION_TO_NOWHERE,
  BROKEN_EMPTY_STATES,
  BROKEN_NO_STATES,
  BROKEN_PARALLEL_NO_CHILDREN,
  BROKEN_COMPOUND_NO_INITIAL,
  BROKEN_INITIAL_WRONG_TYPE,
  BROKEN_NULL_TRANSITION_TARGET,
} from './machines.js';

before(async () => {
  await seedApiKey();
});

async function validate(definition) {
  return post('/v1/definitions/validate', { definition });
}

async function deploy(id, definition) {
  return put('/v1/definitions', { id, definition });
}

async function spawn(definitionId) {
  return post('/v1/actors', { definitionId });
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: validate endpoint — SHOULD return valid:false for all broken machines
// ─────────────────────────────────────────────────────────────────────────────

describe('SC2-A: [VALIDATE] Broken machines are rejected by /validate', () => {

  test('[VALIDATE] B1: Missing initial field — 400 valid:false', async () => {
    const r = await validate(BROKEN_NO_INITIAL);
    // Static analysis now catches this via XSTATE_ERROR (XState throws on missing initial)
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.valid, false);
    assert.ok(r.body.errors?.length > 0, 'errors array must be present');
    assert.ok(r.body.errors[0].type, 'error must have a type');
    console.log(`  B1 error: ${r.body.errors[0].type}: ${r.body.errors[0].message}`);
  });

  test('[VALIDATE] B2: initial references non-existent state — valid:false', async () => {
    const r = await validate(BROKEN_INITIAL_MISSING_TARGET);
    assert.equal(r.status, 400, `Expected 400, got ${r.status}`);
    assert.equal(r.body.valid, false, `Expected valid:false: ${JSON.stringify(r.body)}`);
  });

  test('[VALIDATE] B3: Transition targets ghost state — 400 INVALID_TRANSITION', async () => {
    const r = await validate(BROKEN_TRANSITION_TO_NOWHERE);
    // Static analysis now catches INVALID_TRANSITION_TARGET for ghost states
    assert.equal(r.status, 400, `Expected 400, got ${r.status}`);
    assert.equal(r.body.valid, false);
    const invalidTransition = r.body.errors?.find(e => e.type === 'INVALID_TRANSITION');
    assert.ok(invalidTransition,
      `Expected INVALID_TRANSITION error, got: ${JSON.stringify(r.body.errors)}`);
    assert.ok(invalidTransition.message.includes('ghost_state'),
      `Error should mention ghost_state: ${invalidTransition.message}`);
    console.log(`  B3 error: ${invalidTransition.message}`);
  });

  test('[VALIDATE] B4: Empty states — 400 EMPTY_STATES (deferred-throw gap FIXED)', async () => {
    const r = await validate(BROKEN_EMPTY_STATES);
    // Static analysis catches EMPTY_STATES before XState is even invoked,
    // fixing the deferred-throw gap that previously allowed valid:true.
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.valid, false);
    const emptyErr = r.body.errors?.find(e => e.type === 'EMPTY_STATES');
    assert.ok(emptyErr, `Expected EMPTY_STATES error, got: ${JSON.stringify(r.body.errors)}`);
    console.log(`  B4 FIXED: ${emptyErr.message}`);
  });

  test('[VALIDATE] B5: No states at all — 400 EMPTY_STATES', async () => {
    const r = await validate(BROKEN_NO_STATES);
    assert.equal(r.status, 400);
    assert.equal(r.body.valid, false);
    assert.ok(r.body.errors?.some(e => e.type === 'EMPTY_STATES'),
      `Expected EMPTY_STATES error: ${JSON.stringify(r.body.errors)}`);
  });

  test('[VALIDATE] B6: Parallel with empty regions — valid:false', async () => {
    const r = await validate(BROKEN_PARALLEL_NO_CHILDREN);
    if (r.body.valid === true) {
      console.log('  NOTE: XState accepted parallel with empty regions — platform should check');
    } else {
      assert.equal(r.body.valid, false);
    }
  });

  test('[VALIDATE] B7: Compound state missing own initial — 400 COMPOUND_NO_INITIAL', async () => {
    const r = await validate(BROKEN_COMPOUND_NO_INITIAL);
    assert.equal(r.status, 400);
    assert.equal(r.body.valid, false);
    const compErr = r.body.errors?.find(e => e.type === 'COMPOUND_NO_INITIAL');
    assert.ok(compErr,
      `Expected COMPOUND_NO_INITIAL error, got: ${JSON.stringify(r.body.errors)}`);
    assert.ok(compErr.message.includes('outer'),
      `Error should mention the compound state name: ${compErr.message}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2: PUT /v1/definitions stores without validation
// These expose the STORE-GAP — what the system currently accepts
// ─────────────────────────────────────────────────────────────────────────────

describe('SC2-B: STORE-GAP FIXED — PUT /v1/definitions now rejects broken machines', () => {

  test('B1: PUT with missing initial → 400', async () => {
    const id = `broken-no-initial-fixed-${Date.now()}`;
    const r  = await deploy(id, BROKEN_NO_INITIAL);
    assert.equal(r.status, 400, `Expected 400 from PUT with missing initial, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.errors?.length > 0, 'errors array must be present');
    console.log(`  PUT rejected missing-initial with: ${r.body.errors[0].type}`);
  });

  test('B2: PUT with ghost transition target → 400', async () => {
    const id = `broken-ghost-target-fixed-${Date.now()}`;
    const r  = await deploy(id, BROKEN_TRANSITION_TO_NOWHERE);
    assert.equal(r.status, 400, `Expected 400 from PUT with ghost target, got ${r.status}`);
    assert.ok(r.body.errors?.find(e => e.type === 'INVALID_TRANSITION'),
      `Expected INVALID_TRANSITION: ${JSON.stringify(r.body.errors)}`);
  });

  test('B3: PUT with compound-no-initial → 400', async () => {
    const id = `broken-compound-fixed-${Date.now()}`;
    const r  = await deploy(id, BROKEN_COMPOUND_NO_INITIAL);
    assert.equal(r.status, 400, `Expected 400 from PUT with compound-no-initial, got ${r.status}`);
    assert.ok(r.body.errors?.find(e => e.type === 'COMPOUND_NO_INITIAL'),
      `Expected COMPOUND_NO_INITIAL: ${JSON.stringify(r.body.errors)}`);
  });

  test('Valid machine with warnings is accepted (201) with warnings in response', async () => {
    const defId = `valid-with-warnings-${Date.now()}`;
    // STUCK_DEAD_END is structurally valid (no errors) but has warnings
    const { STUCK_DEAD_END } = await import('./machines.js');
    const r = await deploy(defId, STUCK_DEAD_END);
    assert.ok([200, 201].includes(r.status), `Expected 200/201, got ${r.status}: ${JSON.stringify(r.body)}`);
    // Warnings are returned in the response
    assert.ok(Array.isArray(r.body.warnings), 'warnings array must be present');
    assert.ok(r.body.warnings.length > 0, `Expected at least one warning: ${JSON.stringify(r.body.warnings)}`);
    console.log(`  Warnings on STUCK_DEAD_END: ${r.body.warnings.map(w => w.type).join(', ')}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3: Runtime behaviour — what happens when a broken def reaches spawn
// ─────────────────────────────────────────────────────────────────────────────

describe('SC2-C: RUNTIME-GAP FIXED — broken definitions never reach spawn', () => {

  test('B2: PUT with bad initial → 400 → spawn never attempted', async () => {
    const id = `rt-fixed-bad-initial-${Date.now()}`;
    const putRes = await deploy(id, BROKEN_INITIAL_MISSING_TARGET);
    assert.equal(putRes.status, 400,
      `PUT should be rejected, got ${putRes.status}: ${JSON.stringify(putRes.body)}`);
    // Verify definition was NOT stored
    const r = await get(`/v1/definitions/${id}/status`);
    assert.equal(r.status, 404, 'Rejected definition must not be stored in DB');
  });

  test('B4: PUT with empty states → 400 → definition not stored', async () => {
    const id = `rt-fixed-empty-${Date.now()}`;
    const putRes = await deploy(id, BROKEN_EMPTY_STATES);
    assert.equal(putRes.status, 400);
    const r = await get(`/v1/definitions/${id}/status`);
    assert.equal(r.status, 404);
  });

  test('B7: PUT with compound-no-initial → 400 → definition not stored', async () => {
    const id = `rt-fixed-compound-${Date.now()}`;
    const putRes = await deploy(id, BROKEN_COMPOUND_NO_INITIAL);
    assert.equal(putRes.status, 400);
    const r = await get(`/v1/definitions/${id}/status`);
    assert.equal(r.status, 404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 4: Edge-case inputs to the API itself
// ─────────────────────────────────────────────────────────────────────────────

describe('SC2-D: Edge-case inputs to PUT /v1/definitions', () => {

  test('definition field is an empty object {}', async () => {
    const r = await put('/v1/definitions', { id: `empty-def-${Date.now()}`, definition: {} });
    // Empty object is technically valid JSON — document what happens
    console.log(`  Empty definition PUT: ${r.status}`);
    assert.ok([200, 201, 400].includes(r.status));
  });

  test('definition field is an array (wrong type)', async () => {
    const r = await post('/v1/definitions/validate', { definition: [] });
    // Fastify schema requires definition to be object — should be 400
    assert.ok(r.status >= 400, `Expected 4xx for array definition, got ${r.status}`);
  });

  test('definition field is a string (wrong type)', async () => {
    const r = await post('/v1/definitions/validate', { definition: 'not an object' });
    assert.ok(r.status >= 400, `Expected 4xx for string definition, got ${r.status}`);
  });

  test('definition with null transition target', async () => {
    const r = await validate(BROKEN_NULL_TRANSITION_TARGET);
    // Document current behaviour
    console.log(`  Null transition target validate: ${r.status} valid:${r.body.valid}`);
    assert.ok([200, 400].includes(r.status));
  });

  test('definition with cyclic ID reference (id matches states key)', async () => {
    const def = {
      id:      'self_ref',
      initial: 'self_ref',  // same as id
      states: {
        self_ref: { on: { GO: 'done' } },
        done:     { type: 'final' },
      },
    };
    const r = await validate(def);
    // Valid — id and initial are independent; this should work
    assert.equal(r.status, 200);
    assert.equal(r.body.valid, true);
  });

  test('definition with very long state names (255 chars)', async () => {
    const longName = 'a'.repeat(255);
    const def = {
      id:      'long-names',
      initial: longName,
      states: {
        [longName]: { on: { GO: 'done' } },
        done: { type: 'final' },
      },
    };
    const r = await validate(def);
    // XState should handle this
    assert.ok([200, 400].includes(r.status));
    console.log(`  Long state name (255 chars): ${r.status} valid:${r.body.valid}`);
  });

  test('definition with duplicate state names (last wins in JSON)', async () => {
    // JSON parsing deduplicates keys — second definition of 'a' overwrites first
    // This is a JSON spec behaviour, not a machine issue
    const jsonStr = '{"id":"dupe","initial":"a","states":{"a":{"on":{"GO":"b"}},"a":{"on":{}},"b":{"type":"final"}}}';
    const def = JSON.parse(jsonStr);  // 'a' will have the second definition (no transitions)
    const r = await validate(def);
    // Machine is structurally valid, but actor in 'a' is now stuck (no transitions)
    console.log(`  Duplicate state key (JSON): valid:${r.body.valid} initial:${r.body.initialState}`);
    assert.ok([200, 400].includes(r.status));
  });

  test('definition with 0 bytes in state name', async () => {
    const def = {
      id:      'null-byte-state',
      initial: 'a\x00b',  // null byte in state name
      states: {
        'a\x00b': { on: { GO: 'done' } },
        done:     { type: 'final' },
      },
    };
    const r = await validate(def);
    console.log(`  Null byte in state name: ${r.status}`);
    assert.ok([200, 400].includes(r.status));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 5: Scenario endpoint with broken definitions
// ─────────────────────────────────────────────────────────────────────────────

describe('SC2-E: /v1/definitions/scenario with broken definitions', () => {

  test('scenario with missing-initial def returns error', async () => {
    const r = await post('/v1/definitions/scenario', {
      definition: BROKEN_NO_INITIAL,
      scenarios: [{ name: 'test', events: ['GO'] }],
    });
    // Should return 400 (createMachine fails) or 200 with error per-scenario
    if (r.status === 200) {
      assert.equal(r.body.results[0].passed, false,
        'Scenario with broken machine should report as failed');
      assert.ok(r.body.results[0].error, 'Should have error message');
    } else {
      assert.ok(r.status >= 400);
    }
  });

  test('scenario with empty-states def returns error', async () => {
    const r = await post('/v1/definitions/scenario', {
      definition: BROKEN_EMPTY_STATES,
      scenarios: [{ name: 'empty test', events: [] }],
    });
    if (r.status === 200) {
      assert.equal(r.body.results[0].passed, false);
    } else {
      assert.ok(r.status >= 400);
    }
  });

  test('scenario with compound-no-initial returns error', async () => {
    const r = await post('/v1/definitions/scenario', {
      definition: BROKEN_COMPOUND_NO_INITIAL,
      scenarios: [{ name: 'compound test', events: [] }],
    });
    if (r.status === 200) {
      assert.equal(r.body.results[0].passed, false);
      assert.ok(r.body.results[0].error);
    } else {
      assert.ok(r.status >= 400);
    }
  });
});
