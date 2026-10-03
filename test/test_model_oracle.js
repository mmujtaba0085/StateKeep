/**
 * test/test_model_oracle.js — differential test of the routing code against the
 * machine-checked model.
 *
 * formal/Oracle.lean runs the Lean definitions themselves (`accPlus`, Def 7.7, and the
 * routing chain `routeU`, Def 3.6, from formal/APV.lean, whose theorems are proved about
 * exactly these functions) on random registries. The same registries are loaded into the
 * runtime (routingRegistry.registerScalar / registerParallel, i.e. the C engine plus the
 * digest checks), and three implementations are compared hop by hop with the oracle:
 *   1. lookup()          — the engine path used for live routing,
 *   2. simulateLookup()  — the pure-JS path used for deployment analysis,
 *   3. predictRouting()  — the deployment-analysis chain driver (state mappings total).
 *
 * The model abstracts fingerprints to numbers; here each number stands for a real v2
 * fingerprint (`2:<sha256>`) and each regional key for a (region path, v2 fingerprint) pair.
 *
 * Needs Lean 4.12 (`$LEAN`, or `lean` on PATH); skipped otherwise.
 *
 *   node --test test/test_model_oracle.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { engineReady, getEngine } from '../src/ffi/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ORACLE = path.join(here, '..', 'formal', 'oracle.sh');

function findLean() {
  const cands = [process.env.LEAN, 'lean'].filter(Boolean);
  for (const c of cands) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && /version 4\.12\./.test(r.stdout)) return c;
  }
  return null;
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

const RUNS = Number(process.env.ORACLE_RUNS ?? 1000);
const HISTORIES = [['A'], ['B'], ['A', 'B'], ['AB'], ['B', 'A'], ['A', 'A', 'C']];
const REGIONS = ['par.left', 'par.right', 'par.mid'];
const DEF0 = 100;
// every version has the same shape (state mappings total, as in the oracle) and the three
// parallel regions, so regional fingerprints survive each hop as the model's keys do
const region = { initial: 'x', states: { x: {} } };
const MACHINE = { initial: 'par', states: { par: { type: 'parallel', states: { left: region, right: region, mid: region } } } };
const STATE = { par: { left: 'x', right: 'x', mid: 'x' } };

test('routing code agrees with the Lean model (accPlus and routing chains)', async (t) => {
  const lean = findLean();
  if (!lean || !existsSync(ORACLE)) { t.skip('Lean 4.12 not available'); return; }
  await engineReady;
  const eng = getEngine();
  if (!eng.hasEx) { t.skip('engine build without _ex lookups'); return; }
  const { registerScalar, registerParallel, lookup, simulateLookup } = await import('../src/runtime/routingRegistry.js');
  const { computeHistoryFingerprint } = await import('../src/ffi/fingerprintChain.js');
  const { predictRouting } = await import('../src/runtime/deployAnalysis.js');

  const fpOf = HISTORIES.map((h) => computeHistoryFingerprint(h, 2));
  const fpId = (i) => i + 1;                                   // model number of HISTORIES[i]
  const keyId = (r, i) => 1000 + r * 100 + i;                  // model number of (REGIONS[r], HISTORIES[i])

  const cases = [];      // { line, runtime: [{name, hops}] }
  for (let run = 0; run < RUNS; run++) {
    const rnd = lcg(7919 * (run + 1));
    const fam = `oracle-${process.pid}-${run}`;
    const scal = [], par = [];
    const usedS = new Set(), usedP = new Set();
    const nS = Math.floor(rnd() * 5), nP = Math.floor(rnd() * 4);
    let nextTarget = 200;
    const defs = new Map([[`d${DEF0}`, { id: `d${DEF0}`, deployedAt: 0, definitionJson: MACHINE }]]);
    const addDef = (n, tt) => defs.set(`d${n}`, { id: `d${n}`, deployedAt: tt, definitionJson: MACHINE });
    for (let i = 0; i < nS; i++) {
      let tt; do { tt = 1 + Math.floor(rnd() * 12); } while (usedS.has(tt));
      usedS.add(tt);
      const wild = rnd() < 0.3;
      const h = Math.floor(rnd() * HISTORIES.length);
      const tgt = nextTarget++;
      registerScalar({ tStar: BigInt(tt), storedPrefix: wild ? '0' : '1', childDefId: `d${tgt}`, machineId: fam,
        historyPath: wild ? null : HISTORIES[h] });
      scal.push(`1 ${tt} ${wild ? 'w 0' : `e ${fpId(h)}`} 1 ${tgt}`);
      addDef(tgt, tt);
    }
    for (let i = 0; i < nP; i++) {
      // half the time at a scalar change-point's time: exercises the scalar-wins tie rule
      const free = [...usedS].filter((x) => !usedP.has(x));
      let tt;
      if (free.length && rnd() < 0.5) tt = free[Math.floor(rnd() * free.length)];
      else do { tt = 1 + Math.floor(rnd() * 12); } while (usedP.has(tt));
      usedP.add(tt);
      const sel = {};
      const ks = [];
      for (let r = 0; r < REGIONS.length; r++) {
        if (rnd() < 0.45 || (r === REGIONS.length - 1 && ks.length === 0)) {
          const h = Math.floor(rnd() * 3);                       // few histories: matches are common
          sel[REGIONS[r]] = HISTORIES[h];
          ks.push(keyId(r, h));
        }
      }
      const tgt = nextTarget++;
      const rc = registerParallel({ tStar: BigInt(tt), childDefId: `d${tgt}`, machineId: fam, historyRegions: sel });
      if (rc === -2) continue;
      par.push(`1 ${tt} ${ks.join(',')} 1 ${tgt}`);
      addDef(tgt, tt);
    }
    // the actor
    const h = Math.floor(rnd() * HISTORIES.length);
    const ell = 1 + Math.floor(rnd() * 12);
    const regionFps = {};
    const aks = [];
    if (rnd() < 0.7) {
      for (let r = 0; r < REGIONS.length; r++) {
        if (rnd() < 0.8) { const rh = Math.floor(rnd() * 3); regionFps[REGIONS[r]] = fpOf[rh]; aks.push(keyId(r, rh)); }
      }
    }
    const rf = Object.keys(regionFps).length ? regionFps : null;
    const fams = [...defs.keys()].map((d) => `${d.slice(1)} 1`).join(';');
    const line = `${scal.join(';')}|${par.join(';')}|${DEF0} ${fpId(h)} ${aks.join(',') || '_'} ${ell}|${fams}`;

    // runtime chains: same driver as the model (fingerprint and regional keys unchanged, ℓ := t*+1)
    const chain = (look) => {
      const out = [];
      let T = ell;
      for (let i = 0; i < 64; i++) {
        const hit = look(T);
        if (!hit) break;
        out.push(`${hit.kind === 'parallel' ? 'p' : 's'} ${String(hit.target).slice(1)} ${hit.tStar}`);
        T = Number(hit.tStar) + 1;
      }
      return out.length ? out.join(' ') : 'none';
    };
    const viaEngine = chain((T) => lookup({ machineId: fam, fp: fpOf[h], regionFps: rf, T }));
    const viaSim = chain((T) => simulateLookup({ machineId: fam, fp: fpOf[h], regionFps: rf, T }));
    // predictRouting: the deployment-analysis driver. Its candidate (a scalar at t=13 whose
    // pattern no actor here has) never applies, so the chain is the registry's own.
    const pred = await predictRouting({
      machineId: fam,
      actors: [{ id: 'a', definitionId: `d${DEF0}`, stateValue: STATE, context: {}, historyFingerprint: fpOf[h],
        regionFingerprints: rf, logicalStartTick: ell }],
      getDef: async (id) => defs.get(id) ?? null,
      candidate: { id: 'cand', kind: 's', pattern: ['NEVER_TAKEN'], definitionJson: MACHINE, t: 13n },
    });
    const pr = [...pred.moves, ...pred.stays].find((x) => x.actorId === 'a')?.hops ?? [];
    cases.push({ line, run, viaEngine, viaSim, viaPredict: pr.map((d) => d.slice(1)).join(' ') });
  }

  const res = spawnSync(ORACLE, [], { input: cases.map((c) => c.line).join('\n') + '\n', encoding: 'utf8',
    env: { ...process.env, LEAN: lean }, maxBuffer: 64 << 20, timeout: 600_000 });
  assert.equal(res.status, 0, res.stderr);
  const answers = res.stdout.split('\n').filter((l) => /^(none|error|[sp] )/.test(l));
  assert.equal(answers.length, cases.length, 'one oracle answer per case');
  let routed = 0, multi = 0, parallelHops = 0;
  cases.forEach((c, i) => {
    const want = answers[i].trim();
    const ctx = `run ${c.run}: ${c.line}`;
    assert.equal(c.viaEngine, want, `lookup() chain differs from the model — ${ctx}`);
    assert.equal(c.viaSim, want, `simulateLookup() chain differs from the model — ${ctx}`);
    const targets = want === 'none' ? '' : want.split(' ').filter((_, j) => j % 3 === 1).join(' ');
    assert.equal(c.viaPredict, targets, `predictRouting() chain differs from the model — ${ctx}`);
    if (want !== 'none') routed++;
    if (want.split(' ').length > 3) multi++;
    if (/(^| )p /.test(want)) parallelHops++;
  });
  // the random registries must exercise the interesting cases
  assert.ok(routed > RUNS / 4 && multi > RUNS / 20 && parallelHops > RUNS / 20,
    `coverage: routed ${routed}, multi-hop ${multi}, with parallel hops ${parallelHops}`);
  t.diagnostic(`${cases.length} cases: ${routed} routed, ${multi} multi-hop, ${parallelHops} with parallel hops`);
});
