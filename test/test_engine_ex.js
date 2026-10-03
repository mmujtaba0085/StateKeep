/**
 * test/test_engine_ex.js — randomized differential test of the engine's extended lookups
 * (hit t* and matched key) and of collection, against a small reference model.
 *
 *   node --test test/test_engine_ex.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineReady, getEngine } from '../src/ffi/engine.js';

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

test('scalar/parallel _ex lookups and collection agree with the reference model', async () => {
  await engineReady;
  const eng = getEngine();
  if (!eng.hasEx) return;               // older engine build
  // A fresh registry per run would be cleaner, but the singleton is shared: use scopes
  // no other test uses.
  for (let run = 0; run < 60; run++) {
    const rnd = lcg(1000 + run);
    const scopes = [BigInt(0x7e570000 + run * 2 + 1), BigInt(0x7e570000 + run * 2 + 2)];
    const keys = [0n, 11n, 22n, 33n];
    const regions = [101n, 202n, 303n, 404n];
    const scalar = [];   // { scope, t, key, r, target }
    const par = [];      // { scope, t, set, r, target }
    let t = 1000 + run * 100000;
    const collected = new Map();          // scope -> frontier
    for (let op = 0; op < 120; op++) {
      const x = rnd();
      const scope = scopes[Math.floor(rnd() * 2)];
      if (x < 0.35) {
        t += 1 + Math.floor(rnd() * 3);
        const key = keys[Math.floor(rnd() * keys.length)];
        const target = `s-${run}-${op}`;
        eng.registerChangepoint(BigInt(t), key, 1n, target, scope);
        scalar.push({ scope, t: BigInt(t), key, r: 1n, target });
      } else if (x < 0.55) {
        t += 1 + Math.floor(rnd() * 3);
        const n = 1 + Math.floor(rnd() * 2);
        const set = [...new Set(Array.from({ length: n }, () => regions[Math.floor(rnd() * regions.length)]))];
        const target = `p-${run}-${op}`;
        const rc = eng.registerChangepointParallel(BigInt(t), set, 1n, target, scope);
        if (rc === 0) par.push({ scope, t: BigInt(t), set, r: 1n, target });
      } else if (x < 0.62) {
        const frontier = BigInt(t - Math.floor(rnd() * 8));
        eng.collectBefore(scope, frontier);
        const prev = collected.get(scope) ?? 0n;
        collected.set(scope, frontier > prev ? frontier : prev);
        for (const arr of [scalar, par])
          for (let i = arr.length - 1; i >= 0; i--)
            if (arr[i].scope === scope && arr[i].t < frontier) arr.splice(i, 1);
      } else {
        const T = BigInt(t - Math.floor(rnd() * 12));
        const key = keys[1 + Math.floor(rnd() * 3)];
        const got = eng.computeAccessibleEx(key, T, 0n, scope);
        const cands = scalar.filter((c) => c.scope === scope && c.t >= T && (c.key === key || c.key === 0n))
          .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : (a.key === 0n) - (b.key === 0n)));
        if (cands.length === 0) assert.equal(got, null);
        else {
          assert.equal(got?.target, cands[0].target);
          assert.equal(got?.tStar, cands[0].t);
          assert.equal(got?.key, cands[0].key);
        }
        const held = regions.filter(() => rnd() < 0.6);
        if (held.length) {
          const pg = eng.computeAccessibleParallelEx(held, T, 0n, scope);
          const pc = par.filter((c) => c.scope === scope && c.t >= T && c.set.every((h) => held.includes(h)));
          if (pc.length === 0) assert.equal(pg, null);
          else {
            const tmin = pc.reduce((m, c) => (c.t < m ? c.t : m), pc[0].t);
            assert.equal(pg?.tStar, tmin);
            const atT = pc.filter((c) => c.t === tmin);
            const maxN = Math.max(...atT.map((c) => c.set.length));
            const best = atT.filter((c) => c.set.length === maxN);
            if (best.length === 1) assert.equal(pg?.target, best[0].target);
          }
        }
      }
    }
  }
});

test('routing registry: both fingerprint schemes route, and a 64-bit key collision is caught', async () => {
  await engineReady;
  const eng = getEngine();
  if (!eng.hasEx) return;
  const { registerScalar, lookup } = await import('../src/runtime/routingRegistry.js');
  const { computeHistoryFingerprint, engineKey } = await import('../src/ffi/fingerprintChain.js');
  const fam = `rr-${process.pid}`;
  const { scopeOf } = await import('../src/ffi/engine.js');
  registerScalar({ tStar: 10n, storedPrefix: engineKey(computeHistoryFingerprint(['PAYMENT_OK'], 1)).toString(),
    childDefId: 'rr-v2', machineId: fam, historyPath: ['PAYMENT_OK'] });
  const v2 = computeHistoryFingerprint(['PAYMENT_OK'], 2);
  const v1 = computeHistoryFingerprint(['PAYMENT_OK'], 1);
  assert.equal(lookup({ machineId: fam, fp: v2, T: 1 })?.target, 'rr-v2');
  assert.equal(lookup({ machineId: fam, fp: v1, T: 1 })?.target, 'rr-v2', 'legacy actors are still routed');
  assert.equal(lookup({ machineId: fam, fp: computeHistoryFingerprint(['PAY', 'MENT_OK'], 2), T: 1 }), null);
  // Forge a key collision: the engine answers for an actor whose full digest differs.
  const other = computeHistoryFingerprint(['SOMETHING_ELSE'], 2);
  registerScalar({ tStar: 20n, storedPrefix: '1', childDefId: 'rr-v3', machineId: fam, historyPath: ['X'] });
  eng.registerChangepoint(20n, engineKey(other), 1n, 'rr-v3', scopeOf(fam));
  assert.equal(eng.computeAccessibleEx(engineKey(other), 1n, 0n, scopeOf(fam))?.target, 'rr-v3');
  assert.equal(lookup({ machineId: fam, fp: other, T: 1 }), null, 'the full digest does not match: no route');
});

test('late-matcher check: conflicting parallel leaves are reported (exact per configuration)', async () => {
  const { unplaceableConfigurations, resolveLandingState } = await import('../src/runtime/stateMapping.js');
  const old = { w: { type: 'parallel', states: { A: { initial: 'x', states: { x: {} } }, B: { initial: 'y', states: { y: {} } } } } };
  const nw = { C: { initial: 'p', states: { p: {}, q: {} } } };
  const mapping = { 'w.A': 'C.p', 'w.B': 'C.q' };
  assert.equal(resolveLandingState({ w: { A: 'x', B: 'y' } }, nw, mapping), null);
  assert.deepEqual(unplaceableConfigurations(old, nw, mapping), { leaves: [], pairs: [['w.A.x', 'w.B.y']] });
  assert.deepEqual(unplaceableConfigurations(old, nw, { 'w.A': 'C.p', 'w.B': 'C.p' }), { leaves: [], pairs: [] });
});

test('legacy matches are refused when the pattern splits into the event types in two ways', async () => {
  await engineReady;
  const eng = getEngine();
  if (!eng.hasEx) return;
  const { registerScalar, lookup, markLegacyAmbiguity } = await import('../src/runtime/routingRegistry.js');
  const { computeHistoryFingerprint, engineKey } = await import('../src/ffi/fingerprintChain.js');
  const { legacyPatternAmbiguous, factorizations } = await import('../src/runtime/legacyFingerprints.js');
  assert.equal(factorizations('AB', new Set(['A', 'B', 'AB'])), 2);
  assert.equal(factorizations('PAYMENT_OK', new Set(['PAYMENT_OK', 'PAY'])), 1);
  const fam = `amb-${process.pid}`;
  registerScalar({ tStar: 5n, storedPrefix: engineKey(computeHistoryFingerprint(['AB'], 1)).toString(),
    childDefId: 'amb-v2', machineId: fam, historyPath: ['AB'] });
  const legacy = computeHistoryFingerprint(['A', 'B'], 1);
  assert.equal(lookup({ machineId: fam, fp: legacy, T: 1 })?.target, 'amb-v2');            // before the check
  markLegacyAmbiguity(fam, (p) => legacyPatternAmbiguous(p, new Set(['A', 'B', 'AB'])));
  assert.equal(lookup({ machineId: fam, fp: legacy, T: 1 }), null, 'ambiguous legacy match refused');
  assert.equal(lookup({ machineId: fam, fp: computeHistoryFingerprint(['AB']), T: 1 })?.target, 'amb-v2');
  markLegacyAmbiguity(fam, (p) => legacyPatternAmbiguous(p, new Set(['AB', 'X'])));
  assert.equal(lookup({ machineId: fam, fp: legacy, T: 1 })?.target, 'amb-v2', 'unambiguous: exact');
});
