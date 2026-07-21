/**
 * test/statechart/sc10.parallel-hierarchical.js
 *
 * Unit tests for Tier 1 (hierarchical state resolution) and
 * Tier 3 (parallel per-region fingerprint tracking).
 *
 * No server, no DB required.
 *
 * Run: node --test test/statechart/sc10.parallel-hierarchical.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { engineReady } from '../../src/ffi/engine.js';
import { resolveLandingState } from '../../src/runtime/actorWorker.js';
import {
  computeHistoryHash,
  computeRegionHashes,
  regionFingerprintsToArray,
  fingerprintToBigInt,
  bigIntToHex,
  FNV_OFFSET,
} from '../../src/ffi/hashUtils.js';

await engineReady;

// ── Tier 1: resolveLandingState with compound / parallel states ───────────────

describe('SC10-T1: resolveLandingState — hierarchical and parallel state values', () => {

  // Flat strings (existing behaviour must not regress)
  test('T1-1: flat string — state exists in new machine', () => {
    assert.equal(resolveLandingState('idle', { idle: {}, active: {} }), 'idle');
  });

  test('T1-2: flat string — missing, stateMapping resolves it', () => {
    assert.equal(
      resolveLandingState('old_review', { new_review: {} }, { old_review: 'new_review' }),
      'new_review'
    );
  });

  test('T1-3: flat string — missing, no mapping → null', () => {
    assert.equal(resolveLandingState('ghost', { idle: {} }), null);
  });

  // Compound state values (hierarchical machines)
  test('T1-4: compound object — top-level key exists → returns full object', () => {
    const sv = { payment: { processing: 'pending' } };
    const states = { payment: { type: 'compound', states: { processing: {}, done: {} } }, idle: {} };
    const result = resolveLandingState(sv, states);
    assert.deepEqual(result, sv);
  });

  test('T1-5: compound object — top-level key missing → null', () => {
    const sv = { old_flow: { step: 'a' } };
    const states = { new_flow: {}, idle: {} };
    assert.equal(resolveLandingState(sv, states), null);
  });

  test('T1-6: compound object — stateMapping overrides top-level key', () => {
    const sv = { checkout: { payment: 'unpaid' } };
    const states = { purchase: {}, idle: {} };
    const result = resolveLandingState(sv, states, { checkout: 'purchase' });
    assert.equal(result, 'purchase');
  });

  test('T1-7: compound object — stateMapping points to non-existent state → null', () => {
    const sv = { checkout: { payment: 'unpaid' } };
    const states = { idle: {} };
    assert.equal(resolveLandingState(sv, states, { checkout: 'ghost' }), null);
  });

  // Parallel state values (orthogonal regions)
  test('T1-8: parallel state — active region exists in new machine → returns full object', () => {
    const sv = { active: { payment: 'paid', shipping: 'unselected' } };
    const states = { active: { type: 'parallel', states: { payment: {}, shipping: {} } }, done: {} };
    assert.deepEqual(resolveLandingState(sv, states), sv);
  });

  test('T1-9: parallel state — active region removed in new machine → null', () => {
    const sv = { active: { payment: 'paid', shipping: 'selected' } };
    const states = { archived: {}, done: {} };
    assert.equal(resolveLandingState(sv, states), null);
  });

  test('T1-10: null / empty state value → null', () => {
    assert.equal(resolveLandingState(null, { idle: {} }), null);
    assert.equal(resolveLandingState({}, { idle: {} }), null);
  });
});

// ── Tier 3: per-region hash utilities ────────────────────────────────────────

describe('SC10-T3: computeRegionHashes and regionFingerprintsToArray', () => {

  test('T3-1: computeRegionHashes returns per-region fingerprints', () => {
    const result = computeRegionHashes({
      payment:  ['PAY'],
      shipping: ['SELECT_SHIPPING'],
    });
    assert.equal(typeof result.payment,  'string');
    assert.equal(typeof result.shipping, 'string');
    assert.equal(result.payment.length,  16);
    assert.equal(result.shipping.length, 16);
  });

  test('T3-2: each region hash equals computeHistoryHash for that region', () => {
    const payHash      = computeHistoryHash(['PAY']);
    const shippingHash = computeHistoryHash(['SELECT_SHIPPING']);
    const result       = computeRegionHashes({ payment: ['PAY'], shipping: ['SELECT_SHIPPING'] });
    assert.equal(result.payment,  payHash);
    assert.equal(result.shipping, shippingHash);
  });

  test('T3-3: different event sequences produce different hashes', () => {
    const r1 = computeRegionHashes({ payment: ['PAY'] });
    const r2 = computeRegionHashes({ payment: ['SELECT_SHIPPING'] });
    assert.notEqual(r1.payment, r2.payment);
  });

  test('T3-4: regionFingerprintsToArray converts map to BigInt array', () => {
    const rfp = computeRegionHashes({ payment: ['PAY'], shipping: ['SELECT_SHIPPING'] });
    const arr = regionFingerprintsToArray(rfp);
    assert.ok(Array.isArray(arr));
    assert.equal(arr.length, 2);
    for (const bi of arr) assert.equal(typeof bi, 'bigint');
  });

  test('T3-5: regionFingerprintsToArray returns null for null / empty input', () => {
    assert.equal(regionFingerprintsToArray(null),  null);
    assert.equal(regionFingerprintsToArray({}),    null);
  });

  test('T3-6: empty-history region uses FNV_OFFSET as base (same as FNV chain start)', () => {
    const rfp = computeRegionHashes({ shipping: [] });
    const expected = bigIntToHex(FNV_OFFSET);
    assert.equal(rfp.shipping, expected);
  });

  test('T3-7: region hash order does not matter for regionFingerprintsToArray length', () => {
    const rfp1 = { payment: computeHistoryHash(['PAY']), shipping: computeHistoryHash(['SELECT_SHIPPING']) };
    const rfp2 = { shipping: computeHistoryHash(['SELECT_SHIPPING']), payment: computeHistoryHash(['PAY']) };
    const arr1 = regionFingerprintsToArray(rfp1);
    const arr2 = regionFingerprintsToArray(rfp2);
    assert.equal(arr1.length, arr2.length);
  });
});

// ── Tier 3: per-region fingerprint update simulation ─────────────────────────

describe('SC10-T3b: per-region fingerprint update logic (worker simulation)', () => {
  const FNV_PRIME  = 0x00000100000001B3n;
  const UINT64_MAX = 0xFFFFFFFFFFFFFFFFn;

  function fnv1aUpdate(hash, str) {
    const buf = Buffer.from(String(str), 'utf8');
    for (const byte of buf) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & UINT64_MAX;
    return hash;
  }

  function simulateUpdateFingerprint(hexFp, eventType) {
    const current = (!hexFp || hexFp === '0') ? FNV_OFFSET : BigInt(`0x${hexFp.padStart(16, '0')}`);
    return fnv1aUpdate(current, eventType).toString(16).padStart(16, '0');
  }

  test('T3b-1: PAY only changes payment region fingerprint (not shipping)', () => {
    // Simulate: pre-state has payment='unpaid', post-state has payment='paid' (changed)
    // shipping unchanged throughout
    const rfpBefore = { payment: '0', shipping: '0' };

    // Worker diffs regions: payment changed → update payment fp
    const rfpAfter = { ...rfpBefore };
    rfpAfter.payment = simulateUpdateFingerprint(rfpBefore.payment, 'PAY');

    assert.notEqual(rfpAfter.payment,  rfpBefore.payment);
    assert.equal   (rfpAfter.shipping, rfpBefore.shipping);
  });

  test('T3b-2: payment fingerprint after PAY matches computeHistoryHash([PAY])', () => {
    const fp = simulateUpdateFingerprint('0', 'PAY');
    assert.equal(fp, computeHistoryHash(['PAY']));
  });

  test('T3b-3: chained region events accumulate correctly', () => {
    let fp = simulateUpdateFingerprint('0', 'VERIFY_IDENTITY');
    fp      = simulateUpdateFingerprint(fp,  'PAY');
    assert.equal(fp, computeHistoryHash(['VERIFY_IDENTITY', 'PAY']));
  });
});
