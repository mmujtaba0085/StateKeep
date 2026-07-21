/**
 * test/statechart/sc13.parallel-state-paths.js
 *
 * Focused tests for nested parallel APV state-path utilities.
 *
 * Run: node --test test/statechart/sc13.parallel-state-paths.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { engineReady } from '../../src/ffi/engine.js';
import {
  computeHistoryHash,
  encodeRegionFingerprint,
  regionFingerprintsToArray,
} from '../../src/ffi/hashUtils.js';

await engineReady;
import {
  extractParallelRegionPaths,
  flattenStateValue,
  getStateValueAtPath,
  initializeRegionFingerprints,
  normalizeHistoryRegions,
  updateRegionFingerprintsForTransition,
} from '../../src/runtime/statePaths.js';
import {
  REGION_FINGERPRINTS_VERSION,
  deserializeRegionFingerprints,
  isVersionedRegionFingerprintsPayload,
  serializeRegionFingerprints,
} from '../../src/registry/regionFingerprintCodec.js';

const nestedParallelMachine = {
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
    done: { type: 'final' },
  },
};

describe('SC13-P1: state value flattening', () => {
  test('flattens string and nested object state values', () => {
    assert.deepEqual(flattenStateValue('idle'), ['idle']);
    assert.deepEqual(
      flattenStateValue({ on: { working: 'normal' } }),
      ['on.working.normal']
    );
    assert.deepEqual(
      flattenStateValue({ active: { payment: 'paid', shipping: 'selected' } }),
      ['active.payment.paid', 'active.shipping.selected']
    );
  });

  test('reads active subtree by full path', () => {
    const value = { active: { payment: 'paid', shipping: 'selected' } };
    assert.equal(getStateValueAtPath(value, 'active.payment'), 'paid');
    assert.equal(getStateValueAtPath(value, 'active.shipping'), 'selected');
    assert.equal(getStateValueAtPath(value, 'payment'), undefined);
  });
});

describe('SC13-P2: parallel region path extraction', () => {
  test('extracts root parallel regions', () => {
    const machine = {
      id: 'root-parallel',
      type: 'parallel',
      states: {
        left: { states: { idle: {} } },
        right: { states: { idle: {} } },
      },
    };
    assert.deepEqual(extractParallelRegionPaths(machine), ['left', 'right']);
  });

  test('extracts nested parallel regions', () => {
    assert.deepEqual(
      extractParallelRegionPaths(nestedParallelMachine),
      ['active.payment', 'active.shipping']
    );
  });

  test('extracts deeply nested compound parallel regions', () => {
    const machine = {
      id: 'device',
      initial: 'on',
      states: {
        on: {
          initial: 'working',
          states: {
            working: {
              type: 'parallel',
              states: {
                motor: { states: { normal: {} } },
                sensor: { states: { ready: {} } },
              },
            },
          },
        },
      },
    };
    assert.deepEqual(
      extractParallelRegionPaths(machine),
      ['on.working.motor', 'on.working.sensor']
    );
  });
});

describe('SC13-P3: historyRegions normalization', () => {
  test('keeps full paths and resolves unique short names', () => {
    assert.deepEqual(
      normalizeHistoryRegions({ 'active.payment': ['PAY'], shipping: ['SELECT_SHIPPING'] }, nestedParallelMachine),
      { 'active.payment': ['PAY'], 'active.shipping': ['SELECT_SHIPPING'] }
    );
  });

  test('rejects unknown and ambiguous short names', () => {
    assert.throws(
      () => normalizeHistoryRegions({ billing: ['PAY'] }, nestedParallelMachine),
      /Unknown parallel region/
    );

    const ambiguous = {
      id: 'ambiguous',
      initial: 'active',
      states: {
        active: {
          type: 'parallel',
          states: { payment: { states: {} } },
        },
        archived: {
          type: 'parallel',
          states: { payment: { states: {} } },
        },
      },
    };
    assert.throws(
      () => normalizeHistoryRegions({ payment: ['PAY'] }, ambiguous),
      /Ambiguous parallel region/
    );
  });
});

describe('SC13-P4: region fingerprint updates', () => {
  test('initializes active full-path regions', () => {
    assert.deepEqual(
      initializeRegionFingerprints(
        nestedParallelMachine,
        { active: { payment: 'unpaid', shipping: 'unselected' } }
      ),
      { 'active.payment': '0', 'active.shipping': '0' }
    );
  });

  test('updates only the changed active region', () => {
    const next = updateRegionFingerprintsForTransition(
      nestedParallelMachine,
      { active: { payment: 'unpaid', shipping: 'unselected' } },
      { active: { payment: 'paid', shipping: 'unselected' } },
      'PAY',
      { 'active.payment': '0', 'active.shipping': '0' }
    );
    assert.equal(next['active.payment'], computeHistoryHash(['PAY']));
    assert.equal(next['active.shipping'], '0');
  });

  test('does not update when compound region value only changes object key order', () => {
    const machine = {
      id: 'compound-region',
      initial: 'active',
      states: {
        active: {
          type: 'parallel',
          states: {
            editor: {
              initial: 'main',
              states: {
                main: {
                  type: 'parallel',
                  states: {
                    panel: { initial: 'open', states: { open: {} } },
                    cursor: { initial: 'idle', states: { idle: {} } },
                  },
                },
              },
            },
          },
        },
      },
    };
    const next = updateRegionFingerprintsForTransition(
      machine,
      { active: { editor: { panel: 'open', cursor: 'idle' } } },
      { active: { editor: { cursor: 'idle', panel: 'open' } } },
      'NOOP',
      { 'active.editor': computeHistoryHash(['OPEN_EDITOR']) }
    );
    assert.equal(next['active.editor'], computeHistoryHash(['OPEN_EDITOR']));
  });

  test('requires active before and after before updating a region', () => {
    const next = updateRegionFingerprintsForTransition(
      nestedParallelMachine,
      'done',
      { active: { payment: 'unpaid', shipping: 'unselected' } },
      'REOPEN',
      null
    );
    assert.deepEqual(next, { 'active.payment': '0', 'active.shipping': '0' });
  });
});

describe('SC13-P5: keyed region hashing', () => {
  test('same raw fingerprint in different paths encodes differently', () => {
    const raw = computeHistoryHash(['PAY']);
    const payment = regionFingerprintsToArray({ 'active.payment': raw })[0];
    const shipping = regionFingerprintsToArray({ 'active.shipping': raw })[0];

    assert.notEqual(payment, shipping);
    assert.equal(payment, BigInt(`0x${encodeRegionFingerprint('active.payment', raw)}`));
  });
});

describe('SC13-P6: region fingerprint persistence codec', () => {
  test('stores versioned region fingerprint payloads and round-trips maps', () => {
    const regions = {
      'active.shipping': '0',
      'active.payment': computeHistoryHash(['PAY']),
    };
    const stored = serializeRegionFingerprints(regions);
    const parsed = JSON.parse(stored);

    assert.equal(parsed._v, REGION_FINGERPRINTS_VERSION);
    assert.deepEqual(parsed.regions, {
      'active.payment': computeHistoryHash(['PAY']),
      'active.shipping': '0',
    });
    assert.deepEqual(deserializeRegionFingerprints(stored), parsed.regions);
    assert.equal(isVersionedRegionFingerprintsPayload(stored), true);
  });

  test('rejects legacy unversioned maps instead of silently reusing old hashes', () => {
    const legacy = JSON.stringify({
      'active.payment': computeHistoryHash(['PAY']),
    });

    assert.equal(deserializeRegionFingerprints(legacy), null);
    assert.equal(isVersionedRegionFingerprintsPayload(legacy), false);
    assert.equal(isVersionedRegionFingerprintsPayload(JSON.stringify({ _v: 2, regions: {} })), false);
  });
});
