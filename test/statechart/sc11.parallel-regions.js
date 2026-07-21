/**
 * test/statechart/sc11.parallel-regions.js
 *
 * Unit tests for parallel changepoint persistence and seeding logic.
 * Validates the par_changepoints round-trip: register → serialize → deserialize → reseed.
 *
 * No server, no DB required (tests pure logic layer).
 *
 * Run: node --test test/statechart/sc11.parallel-regions.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeHistoryHash,
  computeRegionHashes,
  regionFingerprintsToArray,
  fingerprintToBigInt,
  bigIntToHex,
  FNV_OFFSET,
} from '../../src/ffi/hashUtils.js';
import { updateRegionFingerprintsForTransition } from '../../src/runtime/statePaths.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Simulate the JSON round-trip that insertParChangepoint / loadParChangepointsAfter do. */
function serializeRegionHashes(regionHexMap) {
  return JSON.stringify(regionHexMap);
}

function deserializeRegionHashes(jsonStr) {
  return JSON.parse(jsonStr);
}

/** Simulate the worker seeding logic: JSON → BigInt[]. */
function hexArrToBigInts(hexArr) {
  return hexArr.map(h => BigInt(`0x${h.padStart(16, '0')}`));
}

function storedRegionsToBigInts(jsonStr) {
  const stored = JSON.parse(jsonStr);
  return Array.isArray(stored) ? hexArrToBigInts(stored) : regionFingerprintsToArray(stored);
}

// ── SC11-P1: par_changepoints serialization round-trip ───────────────────────

describe('SC11-P1: par_changepoints serialization round-trip', () => {

  test('P1-1: region hash map serializes to JSON object and deserializes back', () => {
    const rfp  = computeRegionHashes({ 'active.payment': ['PAY'], 'active.shipping': ['SELECT_SHIPPING'] });
    const json = serializeRegionHashes(rfp);
    const map  = deserializeRegionHashes(json);
    assert.equal(typeof map, 'object', 'deserialized value is an object');
    assert.equal(Object.keys(map).length, 2);
    for (const h of Object.values(map)) {
      assert.equal(typeof h, 'string', 'each element is a hex string');
      assert.equal(h.length, 16, 'each element is 16 chars');
    }
  });

  test('P1-2: round-tripped path-keyed map keeps the raw region fingerprint', () => {
    const rfp     = computeRegionHashes({ 'active.payment': ['PAY'] });
    const json    = serializeRegionHashes(rfp);
    const map     = deserializeRegionHashes(json);

    assert.equal(map['active.payment'], computeHistoryHash(['PAY']));
  });

  test('P1-3: two-region changepoint survives JSON round-trip with correct values', () => {
    const payHash  = computeHistoryHash(['PAY']);
    const shipHash = computeHistoryHash(['SELECT_SHIPPING']);
    const rfp      = { 'active.payment': payHash, 'active.shipping': shipHash };

    const json = serializeRegionHashes(rfp);
    const map  = deserializeRegionHashes(json);
    const bis  = Object.values(map).map(fingerprintToBigInt);

    assert.ok(bis.some(b => b === fingerprintToBigInt(payHash)), 'payment hash present');
    assert.ok(bis.some(b => b === fingerprintToBigInt(shipHash)), 'shipping hash present');
  });

  test('P1-4: empty events produce FNV_OFFSET base hash in each region', () => {
    const rfp = computeRegionHashes({ payment: [], shipping: [] });
    assert.equal(rfp.payment,  bigIntToHex(FNV_OFFSET));
    assert.equal(rfp.shipping, bigIntToHex(FNV_OFFSET));
  });
});

// ── SC11-P2: parallel changepoint seeding simulation ─────────────────────────

describe('SC11-P2: parallel seeding simulation (migrate-worker syncRegistry)', () => {

  /** Simulate what syncRegistry() does: load JSON row → BigInt[] → would-be engine call. */
  function simulateSeed(row) {
    return storedRegionsToBigInts(row.region_hashes);
  }

  test('P2-1: seeded BigInt array matches original regionFingerprintsToArray output', () => {
    const rfp      = computeRegionHashes({ 'active.payment': ['PAY'], 'active.shipping': ['SELECT_SHIPPING'] });
    const original = regionFingerprintsToArray(rfp);

    const row     = { region_hashes: serializeRegionHashes(rfp), t_star: 42, refinement: 0, child_def_id: 'checkout-v2' };
    const seeded  = simulateSeed(row);

    assert.equal(seeded.length, original.length);
    // All original BigInts appear in seeded (order may differ due to JSON object enumeration)
    for (const b of original) {
      assert.ok(seeded.some(s => s === b), `BigInt ${b} found in seeded array`);
    }
  });

  test('P2-2: seeding a single-region changepoint produces one-element BigInt array', () => {
    const rfp     = computeRegionHashes({ 'active.payment': ['PAY', 'CONFIRM'] });
    const row     = { region_hashes: serializeRegionHashes(rfp) };
    const seeded  = simulateSeed(row);
    assert.equal(seeded.length, 1);
    assert.equal(typeof seeded[0], 'bigint');
  });

  test('P2-3: three-region changepoint seeds three distinct BigInts', () => {
    const rfp    = computeRegionHashes({ a: ['E1'], b: ['E2'], c: ['E3'] });
    const row    = { region_hashes: serializeRegionHashes(rfp) };
    const seeded = simulateSeed(row);
    assert.equal(seeded.length, 3);
    const unique = new Set(seeded);
    assert.equal(unique.size, 3, 'all three region hashes are distinct');
  });

  test('P2-4: legacy JSON array rows still seed as raw engine hashes', () => {
    const legacy = JSON.stringify(['0000000000000001', '0000000000000002']);
    assert.deepEqual(simulateSeed({ region_hashes: legacy }), [1n, 2n]);
  });
});

// ── SC11-P3: parallel routing correctness (AND composition) ──────────────────

describe('SC11-P3: parallel routing — AND composition semantics', () => {

  /**
   * Simulates what apv_compute_accessible_parallel would check in the .so:
   * for each region in the stored changepoint, does the actor's region hash match?
   * All must match (AND semantics).
   */
  function simulateParallelMatch(storedRegionHexMap, actorRegionHexMap) {
    for (const [region, storedHex] of Object.entries(storedRegionHexMap)) {
      const actorHex = actorRegionHexMap[region];
      if (!actorHex) return false;
      if (actorHex !== storedHex) return false;
    }
    return true;
  }

  test('P3-1: actor with both regions matching → eligible', () => {
    const cpRegions    = computeRegionHashes({ payment: ['PAY'], shipping: ['SELECT_SHIPPING'] });
    const actorRegions = computeRegionHashes({ payment: ['PAY'], shipping: ['SELECT_SHIPPING'] });
    assert.ok(simulateParallelMatch(cpRegions, actorRegions));
  });

  test('P3-2: actor with only one region matching → not eligible (AND semantics)', () => {
    const cpRegions    = computeRegionHashes({ payment: ['PAY'], shipping: ['SELECT_SHIPPING'] });
    const actorRegions = computeRegionHashes({ payment: ['PAY'], shipping: [] });
    assert.ok(!simulateParallelMatch(cpRegions, actorRegions));
  });

  test('P3-3: actor with no events in any region → not eligible', () => {
    const cpRegions    = computeRegionHashes({ payment: ['PAY'], shipping: ['SELECT_SHIPPING'] });
    const actorRegions = computeRegionHashes({ payment: [], shipping: [] });
    assert.ok(!simulateParallelMatch(cpRegions, actorRegions));
  });

  test('P3-4: actor with extra regions beyond changepoint → eligible (superset)', () => {
    // Changepoint only requires payment + shipping; actor also has billing (extra region).
    // AND composition checks each stored region — extra actor regions are irrelevant.
    const cpRegions    = computeRegionHashes({ payment: ['PAY'], shipping: ['SELECT_SHIPPING'] });
    const actorRegions = computeRegionHashes({ payment: ['PAY'], shipping: ['SELECT_SHIPPING'], billing: ['CHARGE'] });
    assert.ok(simulateParallelMatch(cpRegions, actorRegions));
  });

  test('P3-5: different event ordering in one region produces different hash → not eligible', () => {
    const cpRegions    = computeRegionHashes({ payment: ['PAY', 'CONFIRM'] });
    const actorRegions = computeRegionHashes({ payment: ['CONFIRM', 'PAY'] });
    // FNV chain is order-sensitive; different order → different hash
    assert.ok(!simulateParallelMatch(cpRegions, actorRegions));
  });
});

// ── SC11-P4: per-region fingerprint delta tracking (actorWorker simulation) ──

describe('SC11-P4: per-region fingerprint update — delta tracking', () => {

  const checkoutMachine = {
    id: 'checkout',
    initial: 'active',
    states: {
      active: {
        type: 'parallel',
        states: {
          payment: {
            initial: 'unpaid',
            states: {
              unpaid: {},
              paid: {},
            },
          },
          shipping: {
            initial: 'unselected',
            states: {
              unselected: {},
              selected: {},
            },
          },
        },
      },
    },
  };

  /** Simulate actorWorker handleEvent() per-region diff: only update region if state changed. */
  function simulateRegionUpdate(preStateValue, postStateValue, eventType, rfpBefore) {
    return updateRegionFingerprintsForTransition(
      checkoutMachine,
      preStateValue,
      postStateValue,
      eventType,
      rfpBefore
    );
  }

  test('P4-1: PAY event changes payment region, not shipping', () => {
    const pre  = { active: { payment: 'unpaid', shipping: 'unselected' } };
    const post = { active: { payment: 'paid',   shipping: 'unselected' } };
    const rfp  = simulateRegionUpdate(pre, post, 'PAY', { 'active.payment': '0', 'active.shipping': '0' });
    // active region changed → updated
    assert.equal(rfp['active.payment'], computeHistoryHash(['PAY']));
    // No per-sub-region tracking at this level (active is the top-level key)
    assert.equal(rfp['active.shipping'], '0');
  });

  test('P4-2: unchanged region keeps its old fingerprint', () => {
    const pre  = { active: { payment: 'unpaid', shipping: 'selected' } };
    const post = { active: { payment: 'paid',   shipping: 'selected' } };
    const rfp0 = { 'active.payment': '0', 'active.shipping': computeHistoryHash(['SELECT_SHIPPING']) };
    const rfp1 = simulateRegionUpdate(pre, post, 'PAY', rfp0);

    assert.notEqual(rfp1['active.payment'],  rfp0['active.payment'],  'payment updated');
    assert.equal   (rfp1['active.shipping'], rfp0['active.shipping'],  'shipping unchanged');
  });

  test('P4-3: sequential region events accumulate correctly', () => {
    const states = [
      { active: { payment: 'unpaid',  shipping: 'unselected' } },
      { active: { payment: 'paid',    shipping: 'unselected' } },
      { active: { payment: 'paid',    shipping: 'selected'   } },
    ];
    let rfp = { 'active.payment': '0', 'active.shipping': '0' };
    rfp = simulateRegionUpdate(states[0], states[1], 'PAY',               rfp);
    rfp = simulateRegionUpdate(states[1], states[2], 'SELECT_SHIPPING',    rfp);

    assert.equal(rfp['active.payment'],  computeHistoryHash(['PAY']));
    assert.equal(rfp['active.shipping'], computeHistoryHash(['SELECT_SHIPPING']));
  });
});
