/**
 * test/statechart/sc9.unit.js
 *
 * Unit and direct-logic tests for migration routing gaps 1–5.
 * No server, no DB required — runs cleanly in any environment.
 *
 * Run: node --test test/statechart/sc9.unit.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FNV_OFFSET,
  computeHistoryHash,
  fingerprintToBigInt,
  bigIntToHex,
} from '../../src/ffi/hashUtils.js';

// ── Replicate worker algorithm for cross-checking ─────────────────────────────

const FNV_PRIME  = 0x00000100000001B3n;
const UINT64_MAX = 0xFFFFFFFFFFFFFFFFn;

function workerFnv1aUpdate(hash, str) {
  const buf = Buffer.from(String(str), 'utf8');
  for (const byte of buf) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & UINT64_MAX;
  }
  return hash;
}

/** Simulate actorWorker incremental chain (post Gap-2 fix: starts from FNV_OFFSET) */
function workerChain(events) {
  let h = FNV_OFFSET;                                    // Gap 2 fix: '0' → FNV_OFFSET
  for (const evt of events) h = workerFnv1aUpdate(h, evt);
  return h.toString(16).padStart(16, '0');
}

/** Simulate the old (broken) worker that started from 0n */
function brokenWorkerChain(events) {
  let h = 0n;
  for (const evt of events) h = workerFnv1aUpdate(h, evt);
  return h.toString(16).padStart(16, '0');
}

// ─────────────────────────────────────────────────────────────────────────────
// U: computeHistoryHash unit contracts
// ─────────────────────────────────────────────────────────────────────────────

describe('SC9-U: computeHistoryHash unit contracts', () => {

  test('U1: single event — computeHistoryHash matches worker chain', () => {
    const events = ['START_APPLICATION'];
    assert.equal(computeHistoryHash(events), workerChain(events));
  });

  test('U1: loan 3-event path matches worker chain', () => {
    const events = ['START_APPLICATION', 'SUBMIT_PERSONAL_INFO', 'PAY_FEE'];
    assert.equal(computeHistoryHash(events), workerChain(events));
  });

  test('U1: 10-event sequence matches worker chain', () => {
    const events = ['A','B','C','D','E','F','G','H','I','J'];
    assert.equal(computeHistoryHash(events), workerChain(events));
  });

  test('U2: Gap 2 fix — worker starts from FNV_OFFSET not 0n', () => {
    const correct = computeHistoryHash(['START']);       // starts from FNV_OFFSET
    const broken  = brokenWorkerChain(['START']);        // starts from 0n (old bug)
    assert.notEqual(correct, broken,
      'FNV_OFFSET start and 0n start must produce different hashes — Gap 2 verifies this');
    console.log(`  Correct (FNV_OFFSET start): ${correct}`);
    console.log(`  Broken  (0n start):         ${broken}`);
  });

  test('U2: FNV_OFFSET is the standard 64-bit offset basis', () => {
    assert.equal(FNV_OFFSET, 0xcbf29ce484222325n);
  });

  test('U2: computeHistoryHash matches worker, NOT broken-worker', () => {
    const events = ['START_APPLICATION', 'SUBMIT_PERSONAL_INFO', 'PAY_FEE'];
    const hash   = computeHistoryHash(events);
    const worker = workerChain(events);
    const broken = brokenWorkerChain(events);
    assert.equal(hash, worker, 'Must match corrected worker');
    assert.notEqual(hash, broken, 'Must differ from broken worker');
  });

  test('U3: order matters — hash([A,B]) ≠ hash([B,A])', () => {
    const ab = computeHistoryHash(['A', 'B']);
    const ba = computeHistoryHash(['B', 'A']);
    assert.notEqual(ab, ba, 'Event order must affect the hash');
  });

  test('U4: prefix sensitivity — adding one event changes the hash', () => {
    const two   = computeHistoryHash(['START_APPLICATION', 'SUBMIT_PERSONAL_INFO']);
    const three = computeHistoryHash(['START_APPLICATION', 'SUBMIT_PERSONAL_INFO', 'PAY_FEE']);
    assert.notEqual(two, three, 'Adding an event must change the fingerprint');
  });

  test('U5: empty historyPath → bigIntToHex(FNV_OFFSET)', () => {
    const fp = computeHistoryHash([]);
    assert.equal(fp, bigIntToHex(FNV_OFFSET),
      'Empty path must return FNV_OFFSET hex (zero-event fingerprint)');
    assert.equal(fp.length, 16);
    assert.match(fp, /^[0-9a-f]{16}$/);
  });

  test('U5: absent historyPath in deployment → wildcard prefix_hash = 0n', () => {
    // Simulates the definitions.js logic
    const historyPath = undefined;
    const hasHistoryPath = Array.isArray(historyPath) && historyPath.length > 0;
    const prefixHash = hasHistoryPath
      ? fingerprintToBigInt(computeHistoryHash(historyPath))
      : 0n;
    assert.equal(prefixHash, 0n, 'Absent historyPath must produce wildcard 0n');
  });

  test('U5: empty array historyPath → wildcard prefix_hash = 0n', () => {
    const historyPath = [];
    const hasHistoryPath = Array.isArray(historyPath) && historyPath.length > 0;
    const prefixHash = hasHistoryPath
      ? fingerprintToBigInt(computeHistoryHash(historyPath))
      : 0n;
    assert.equal(prefixHash, 0n, 'Empty array historyPath must produce wildcard 0n');
  });

  test('U6: non-empty historyPath → prefix_hash ≠ 0n', () => {
    const historyPath = ['START_APPLICATION', 'SUBMIT_PERSONAL_INFO', 'PAY_FEE'];
    const prefixHash  = fingerprintToBigInt(computeHistoryHash(historyPath));
    assert.notEqual(prefixHash, 0n, 'Non-empty historyPath must produce non-zero hash');
  });

  test('U6: paid path ≠ waived path prefix_hash', () => {
    const paid  = fingerprintToBigInt(computeHistoryHash(['START', 'SUBMIT', 'PAY_FEE']));
    const waive = fingerprintToBigInt(computeHistoryHash(['START', 'SUBMIT', 'WAIVE_FEE']));
    assert.notEqual(paid, waive, 'Different event paths must produce different prefix_hashes');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D: Direct routing mock tests — no DB, simulated actors
// ─────────────────────────────────────────────────────────────────────────────

describe('SC9-D: Direct routing mock — matching migrates, non-matching stays', () => {

  // Mock engine that simulates apv_compute_accessible routing logic:
  //   - prefix_hash = 0n  → wildcard, all actors migrate
  //   - prefix_hash = X   → only actors whose fingerprint === X migrate
  // (In the real engine this is a prefix-history check inside the APV registry;
  //  for unit testing the routing DECISION, exact-match is sufficient.)

  function makeRoutingEngine(changepoints) {
    return {
      computeAccessible(currentFp, actorLogicalTime, currentTime) {
        for (const cp of changepoints) {
          if (cp.prefixHash === 0n)              return cp.targetDefId; // wildcard
          if (cp.prefixHash === currentFp)       return cp.targetDefId; // exact path match
        }
        return null;  // stay
      },
    };
  }

  function simulateDeployment(engine, actors) {
    return actors
      .map(actor => {
        const fp     = fingerprintToBigInt(actor.historyFingerprint);
        const target = engine.computeAccessible(fp, BigInt(actor.logicalStartTick), 9999n);
        return target ? { actorId: actor.id, targetDefId: target } : null;
      })
      .filter(Boolean);
  }

  test('D3: paid actor migrates, waived actor stays (Gap 1 core routing)', () => {
    const PAID_PATH   = ['START_APPLICATION', 'SUBMIT_PERSONAL_INFO', 'PAY_FEE'];
    const WAIVED_PATH = ['START_APPLICATION', 'SUBMIT_PERSONAL_INFO', 'WAIVE_FEE'];

    const actorA = { id: 'actor-paid',   historyFingerprint: computeHistoryHash(PAID_PATH),   logicalStartTick: 1000 };
    const actorB = { id: 'actor-waived', historyFingerprint: computeHistoryHash(WAIVED_PATH), logicalStartTick: 1000 };

    const paidPrefixHash = fingerprintToBigInt(computeHistoryHash(PAID_PATH));
    const engine = makeRoutingEngine([{ prefixHash: paidPrefixHash, targetDefId: 'loan-v2' }]);

    const jobs = simulateDeployment(engine, [actorA, actorB]);

    assert.equal(jobs.length, 1, `Expected 1 job, got ${jobs.length}`);
    assert.equal(jobs[0].actorId,   'actor-paid', 'Must be the paid actor');
    assert.equal(jobs[0].targetDefId, 'loan-v2');

    const waiveJob = jobs.find(j => j.actorId === 'actor-waived');
    assert.equal(waiveJob, undefined, 'Waived actor must NOT get a job');

    console.log('  actor-paid   → migrate to loan-v2 ✓');
    console.log('  actor-waived → stay ✓');
  });

  test('D3: actor with MORE events than historyPath but same prefix stays vs migrates', () => {
    // Actor C processed PAID_PATH + extra events — their fingerprint ≠ prefix_hash
    // because the prefix_hash only matches the state AT THAT POINT in history.
    // The real engine uses APV prefix-history matching (not exact match).
    // This test documents the limitation of the exact-match mock.
    const PAID_PATH = ['START_APPLICATION', 'SUBMIT_PERSONAL_INFO', 'PAY_FEE'];
    const EXTENDED  = [...PAID_PATH, 'UPLOAD_DOCS', 'VERIFY_INCOME'];

    const paidHash     = computeHistoryHash(PAID_PATH);
    const extendedHash = computeHistoryHash(EXTENDED);

    // With our exact-match mock, extended actor does NOT match (different hash)
    // With the real APV engine, it WOULD match (prefix-history check)
    assert.notEqual(paidHash, extendedHash,
      'Extended fingerprint differs from paid-path fingerprint (expected)');

    // Document this: in production with real engine, EXTENDED actor also migrates
    // In tests with mock, we can only verify fingerprints are correct
    console.log('  Extended path hash ≠ paid path hash — real engine would still match via prefix history');
    console.log('  Mock engine uses exact match (sufficient for unit testing routing logic)');
  });

  test('D4: wildcard deploy (0n) routes ALL actors regardless of fingerprint', () => {
    const actors = [
      { id: 'a1', historyFingerprint: computeHistoryHash(['A', 'B']),    logicalStartTick: 1000 },
      { id: 'a2', historyFingerprint: computeHistoryHash(['X', 'Y', 'Z']), logicalStartTick: 1000 },
      { id: 'a3', historyFingerprint: computeHistoryHash(['START']),     logicalStartTick: 1000 },
    ];

    const engine = makeRoutingEngine([{ prefixHash: 0n, targetDefId: 'def-v2' }]);
    const jobs   = simulateDeployment(engine, actors);

    assert.equal(jobs.length, 3, 'All actors must get migration jobs with wildcard');
    assert.ok(jobs.every(j => j.targetDefId === 'def-v2'));
    console.log('  All 3 actors → def-v2 (wildcard) ✓');
  });

  test('D5: rescue — only buggy-path actors get rescue job, others unaffected', () => {
    const BUGGY_PATH  = ['START', 'SUBMIT', 'TRIGGER_BUG'];
    const NORMAL_PATH = ['START', 'SUBMIT'];

    const actors = [
      { id: 'buggy-1', historyFingerprint: computeHistoryHash(BUGGY_PATH),  logicalStartTick: 6000 },
      { id: 'buggy-2', historyFingerprint: computeHistoryHash(BUGGY_PATH),  logicalStartTick: 6000 },
      { id: 'normal-1',historyFingerprint: computeHistoryHash(NORMAL_PATH), logicalStartTick: 6000 },
      { id: 'normal-2',historyFingerprint: computeHistoryHash(['OTHER']),    logicalStartTick: 6000 },
    ];

    const buggyPrefixHash = fingerprintToBigInt(computeHistoryHash(BUGGY_PATH));
    const engine = makeRoutingEngine([{ prefixHash: buggyPrefixHash, targetDefId: 'v2-rescue' }]);
    const jobs   = simulateDeployment(engine, actors);

    assert.equal(jobs.length, 2, 'Only 2 buggy actors must get rescue jobs');
    assert.ok(jobs.every(j => j.targetDefId === 'v2-rescue'));
    assert.ok(jobs.every(j => j.actorId.startsWith('buggy-')));

    const normalJobs = jobs.filter(j => j.actorId.startsWith('normal-'));
    assert.equal(normalJobs.length, 0, 'Normal actors must not be rescued');

    console.log('  buggy-1  → v2-rescue ✓');
    console.log('  buggy-2  → v2-rescue ✓');
    console.log('  normal-1 → stay ✓');
    console.log('  normal-2 → stay ✓');
  });

  test('D: prefix_hash computation matches fingerprintToBigInt(computeHistoryHash(path))', () => {
    // Verify the exact computation used in definitions.js Gap 1 fix
    const PAID_PATH = ['START_APPLICATION', 'SUBMIT_PERSONAL_INFO', 'PAY_FEE'];

    // Absent historyPath → 0n
    const noPath = (function() {
      const hp = undefined;
      const has = Array.isArray(hp) && hp.length > 0;
      return has ? fingerprintToBigInt(computeHistoryHash(hp)) : 0n;
    })();
    assert.equal(noPath, 0n);

    // With historyPath
    const withPath = (function() {
      const hp = PAID_PATH;
      const has = Array.isArray(hp) && hp.length > 0;
      return has ? fingerprintToBigInt(computeHistoryHash(hp)) : 0n;
    })();
    assert.notEqual(withPath, 0n);

    // Must equal what makeRoutingEngine receives when we register the changepoint
    const directHash = fingerprintToBigInt(computeHistoryHash(PAID_PATH));
    assert.equal(withPath, directHash);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E: Fingerprint edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('SC9-E: Fingerprint edge cases', () => {

  test('Empty event sequence → bigIntToHex(FNV_OFFSET)', () => {
    assert.equal(computeHistoryHash([]), bigIntToHex(FNV_OFFSET));
  });

  test('Unicode event type hashes consistently', () => {
    const h1 = computeHistoryHash(['こんにちは', 'PAY_FEE']);
    const h2 = computeHistoryHash(['こんにちは', 'PAY_FEE']);
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{16}$/);
  });

  test('1000-event sequence produces valid 16-char hex', () => {
    const events = Array.from({ length: 1000 }, (_, i) => `EVENT_${i}`);
    const fp = computeHistoryHash(events);
    assert.match(fp, /^[0-9a-f]{16}$/, `1000 events must still produce valid hex: ${fp}`);
  });

  test("'A' and 'B' hash differently", () => {
    assert.notEqual(computeHistoryHash(['A']), computeHistoryHash(['B']));
  });

  test('computeHistoryHash output is always 16 lowercase hex chars', () => {
    const inputs = [['SINGLE'], ['A','B'], ['X','Y','Z','W']];
    for (const events of inputs) {
      const fp = computeHistoryHash(events);
      assert.equal(fp.length, 16, `Expected 16 chars for ${JSON.stringify(events)}: ${fp}`);
      assert.match(fp, /^[0-9a-f]{16}$/, `Must be lowercase hex: ${fp}`);
    }
  });
});
