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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Simulate the JSON round-trip that insertParChangepoint / loadParChangepointsAfter do. */
function serializeRegionHashes(regionHexMap) {
  const arr = Object.values(regionHexMap);
  return JSON.stringify(arr);
}

function deserializeRegionHashes(jsonStr) {
  return JSON.parse(jsonStr);
}

/** Simulate the worker seeding logic: JSON → BigInt[]. */
function hexArrToBigInts(hexArr) {
  return hexArr.map(h => BigInt(`0x${h.padStart(16, '0')}`));
}

// ── SC11-P1: par_changepoints serialization round-trip ───────────────────────

describe('SC11-P1: par_changepoints serialization round-trip', () => {

  test('P1-1: region hash map serializes to JSON array and deserializes back', () => {
    const rfp  = computeRegionHashes({ payment: ['PAY'], shipping: ['SELECT_SHIPPING'] });
    const json = serializeRegionHashes(rfp);
    const arr  = deserializeRegionHashes(json);
    assert.ok(Array.isArray(arr), 'deserialized value is an array');
    assert.equal(arr.length, 2);
    for (const h of arr) {
      assert.equal(typeof h, 'string', 'each element is a hex string');
      assert.equal(h.length, 16, 'each element is 16 chars');
    }
  });

  test('P1-2: round-tripped hex strings convert back to correct BigInts', () => {
    const rfp     = computeRegionHashes({ payment: ['PAY'] });
    const json    = serializeRegionHashes(rfp);
    const arr     = deserializeRegionHashes(json);
    const bigInts = hexArrToBigInts(arr);

    const expected = fingerprintToBigInt(computeHistoryHash(['PAY']));
    assert.ok(bigInts.includes(expected), 'BigInt from round-trip matches direct computation');
  });

  test('P1-3: two-region changepoint survives JSON round-trip with correct values', () => {
    const payHash  = computeHistoryHash(['PAY']);
    const shipHash = computeHistoryHash(['SELECT_SHIPPING']);
    const rfp      = { payment: payHash, shipping: shipHash };

    const json = serializeRegionHashes(rfp);
    const arr  = deserializeRegionHashes(json);
    const bis  = hexArrToBigInts(arr);

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
    const hexArr   = JSON.parse(row.region_hashes);
    const regionArr = hexArr.map(h => BigInt(`0x${h.padStart(16, '0')}`));
    return regionArr;
  }

  test('P2-1: seeded BigInt array matches original regionFingerprintsToArray output', () => {
    const rfp      = computeRegionHashes({ payment: ['PAY'], shipping: ['SELECT_SHIPPING'] });
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
    const rfp     = computeRegionHashes({ payment: ['PAY', 'CONFIRM'] });
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

  /** Simulate actorWorker handleEvent() per-region diff: only update region if state changed. */
  function simulateRegionUpdate(preStateValue, postStateValue, eventType, rfpBefore) {
    const rfpAfter = { ...rfpBefore };
    if (preStateValue && typeof preStateValue === 'object') {
      for (const region of Object.keys(preStateValue)) {
        if (JSON.stringify(preStateValue[region]) !== JSON.stringify(postStateValue?.[region])) {
          rfpAfter[region] = simulateUpdateFingerprint(rfpBefore[region] ?? '0', eventType);
        }
      }
    }
    return rfpAfter;
  }

  test('P4-1: PAY event changes payment region, not shipping', () => {
    const pre  = { active: { payment: 'unpaid', shipping: 'unselected' } };
    const post = { active: { payment: 'paid',   shipping: 'unselected' } };
    const rfp  = simulateRegionUpdate(pre, post, 'PAY', { active: '0' });
    // active region changed → updated
    assert.notEqual(rfp.active, '0');
    // No per-sub-region tracking at this level (active is the top-level key)
    assert.equal(Object.keys(rfp).length, 1);
  });

  test('P4-2: unchanged region keeps its old fingerprint', () => {
    const pre  = { payment: 'unpaid', shipping: 'selected' };
    const post = { payment: 'paid',   shipping: 'selected' };
    const rfp0 = { payment: '0', shipping: computeHistoryHash(['SELECT_SHIPPING']) };
    const rfp1 = simulateRegionUpdate(pre, post, 'PAY', rfp0);

    assert.notEqual(rfp1.payment,  rfp0.payment,  'payment updated');
    assert.equal   (rfp1.shipping, rfp0.shipping,  'shipping unchanged');
  });

  test('P4-3: sequential region events accumulate correctly', () => {
    const states = [
      { payment: 'unpaid',  shipping: 'unselected' },
      { payment: 'paid',    shipping: 'unselected' },
      { payment: 'paid',    shipping: 'selected'   },
    ];
    let rfp = { payment: '0', shipping: '0' };
    rfp = simulateRegionUpdate(states[0], states[1], 'PAY',               rfp);
    rfp = simulateRegionUpdate(states[1], states[2], 'SELECT_SHIPPING',    rfp);

    assert.equal(rfp.payment,  computeHistoryHash(['PAY']));
    assert.equal(rfp.shipping, computeHistoryHash(['SELECT_SHIPPING']));
  });
});
