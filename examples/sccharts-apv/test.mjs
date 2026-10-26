import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSctx, leafPaths } from './sctx.js';
import { Registry, fingerprint } from './apv.js';
import { activeLeaves } from './tick.js';
import { previewSvg } from './diagram.js';

const model = (f) => parseSctx(readFileSync(new URL(`./models/${f}`, import.meta.url), 'utf8'));
const leaves = (reg, i) => activeLeaves(reg.versions.get(i.version).chart, i).map((p) => p.split('.').pop());
const fresh = () => { const r = new Registry(); r.deploy({ id: 'abro-v1', chart: model('abro-v1.sctx') }); return r; };

test('parser: ABRO structure and transition ids', () => {
  const c = model('abro-v1.sctx');
  assert.equal(c.name, 'ABRO');
  assert.deepEqual(c.inputs, ['A', 'B', 'R']);
  assert.deepEqual(leafPaths(c).sort(), ['ABthenO.Done', 'ABthenO.WaitAB.HandleA.DoneA', 'ABthenO.WaitAB.HandleA.WaitA', 'ABthenO.WaitAB.HandleB.DoneB', 'ABthenO.WaitAB.HandleB.WaitB']);
  const ids = [...c.states.values()].flatMap((s) => s.transitions.map((t) => `${t.id}:${t.kind}`));
  assert.ok(ids.includes('ABthenO->ABthenO:abort'));
  assert.ok(ids.includes('ABthenO.WaitAB->ABthenO.Done:join'));
});

test('parser: unsupported constructs are reported, not ignored', () => {
  assert.throws(() => parseSctx('scchart X { input int n initial state A }'), /not supported/);
  assert.throws(() => parseSctx('scchart X { input bool a initial state A if pre(a) go to A }'), /not supported/);
  assert.throws(() => parseSctx('scchart X { input bool a initial state A if a go to B }'), /no state "B"/);
  assert.throws(() => parseSctx('scchart X { state A }'), /exactly one initial/);
});

test('ticks: ABRO emits O once A and B have both been present; R restarts', () => {
  const reg = fresh();
  for (const order of [[['A'], ['B']], [['B'], ['A']], [['A', 'B']]]) {
    const i = reg.spawn('ABRO');
    for (const p of order) reg.tick(i, p);
    assert.equal(i.outputs.O, true, `order ${JSON.stringify(order)}`);
    assert.deepEqual(leaves(reg, i), ['Done']);
    reg.tick(i, ['R']);
    assert.equal(i.outputs.O, false);
    assert.deepEqual(leaves(reg, i), ['WaitA', 'WaitB']);
  }
  const i = reg.spawn('ABRO');
  reg.tick(i, ['A', 'R']);                      // strong abort preempts the inner step
  assert.deepEqual(leaves(reg, i), ['WaitA', 'WaitB']);
});

test('ticks: immediate transitions, delayed transitions, entry/exit/during actions', () => {
  const c = parseSctx(`scchart T { input bool g output bool e = false output bool x = false output bool d = false
    initial state S0 immediate go to S1
    state S1 { entry do e = true  exit do x = true  during do d = true } if g go to S2
    final state S2 }`);
  const reg = new Registry(); reg.deploy({ id: 't1', chart: c });
  const i = reg.spawn('T');
  assert.equal(i.active.has('S1'), true, 'immediate transition taken on entry');
  assert.equal(i.outputs.e, true);
  reg.tick(i, []); assert.equal(i.outputs.d, true, 'during runs in later ticks');
  reg.tick(i, ['g']); assert.equal(i.outputs.x, true); assert.equal(i.status, 'finished');
});

test('fingerprints are StateKeep\'s v2 chain', async () => {
  const sk = await import('../../src/ffi/fingerprintChain.js').catch(() => null);
  if (!sk) return;                              // run outside the StateKeep repository
  const h = ['a->b', 'b->c', 'ünï->cødé'];
  assert.equal(fingerprint(h), sk.computeHistoryFingerprintV2(h));
  assert.equal(fingerprint([]), sk.computeHistoryFingerprintV2([]));
});

test('routing: whole-history patterns, late matchers move at their next tick, the rest stay', () => {
  const reg = fresh();
  const exact = reg.spawn('ABRO'); reg.tick(exact, ['B']);          // history [WaitB->DoneB]
  const late = reg.spawn('ABRO');                                    // empty history: may match later
  const past = reg.spawn('ABRO'); reg.tick(past, ['B']); reg.tick(past, ['A']);   // already past
  const other = reg.spawn('ABRO'); reg.tick(other, ['A']);           // different history
  reg.deploy({ id: 'abro-v2', chart: model('abro-v2.sctx'), historyPath: ['WaitB->DoneB'] });
  assert.equal(exact.version, 'abro-v2');
  assert.equal(late.version, 'abro-v1');
  reg.tick(late, ['B']);                                             // reaches the pattern…
  assert.equal(late.version, 'abro-v1');
  reg.tick(late, []);                                                // …and moves before its next tick
  assert.equal(late.version, 'abro-v2');
  reg.tick(past, []); reg.tick(other, []);
  assert.equal(past.version, 'abro-v1');
  assert.equal(other.version, 'abro-v1');
  // the new behaviour applies to migrated instances
  reg.tick(exact, ['T']);
  assert.equal(exact.outputs.O, true);
});

test('routing: logical time — an instance is never routed by a deployment older than itself', () => {
  const reg = fresh();
  const a = reg.spawn('ABRO');
  reg.deploy({ id: 'abro-v2', chart: model('abro-v2.sctx') });       // wildcard
  assert.equal(a.version, 'abro-v2');
  assert.equal(a.ell, 3);
  const pinned = reg.spawn('abro-v1');                               // spawned after v2, pinned to v1
  reg.tick(pinned, []);
  assert.equal(pinned.version, 'abro-v1', 'v2 is older than this instance');
  assert.equal(reg.spawn('ABRO').version, 'abro-v2', 'by family: the newest version');
});

test('routing is deterministic: equal histories, equal answers', () => {
  const reg = fresh();
  const xs = Array.from({ length: 6 }, () => { const i = reg.spawn('ABRO'); reg.tick(i, ['B']); return i; });
  reg.deploy({ id: 'abro-v2', chart: model('abro-v2.sctx'), historyPath: ['WaitB->DoneB'] });
  assert.equal(new Set(xs.map((i) => i.version)).size, 1);
});

test('migration: mapping by dotted prefix, new regions enter their initial state, conflicts strand', () => {
  const v1 = parseSctx(`scchart M { input bool a
    initial state P { initial state X if a go to Y  state Y }  }`);
  const v2 = parseSctx(`scchart M { input bool a
    initial state Q { region R1 { initial state X if a go to Y  state Y } region R2 { initial state Z } } }`);
  const reg = new Registry(); reg.deploy({ id: 'm1', chart: v1 });
  const i = reg.spawn('M'); reg.tick(i, ['a']);
  const p = reg.preview({ id: 'm2', chart: v2, stateMapping: { P: 'Q.R1' } });
  assert.equal(p.migrate.length, 1);
  reg.deploy({ id: 'm2', chart: v2, stateMapping: { P: 'Q.R1' } });
  assert.equal(i.version, 'm2');
  assert.deepEqual([...activeLeaves(v2, i)].sort(), ['Q.R1.Y', 'Q.R2.Z']);

  // two leaves mapped into one region: cannot be placed → stranded (with consent)
  const v3 = parseSctx(`scchart M { input bool a  initial state S { initial state W } }`);
  const pv = reg.preview({ id: 'm3', chart: v3, stateMapping: { 'Q.R1.Y': 'S.W', 'Q.R2.Z': 'S' } });
  assert.equal(pv.stranded.length, 0, 'S maps to its initial descendant W: both land on W, which is one leaf');
  const v4 = parseSctx(`scchart M { input bool a  initial state S { initial state W  state V } }`);
  const pc = reg.preview({ id: 'm4', chart: v4, stateMapping: { 'Q.R1.Y': 'S.W', 'Q.R2.Z': 'S.V' } });
  assert.equal(pc.stranded.length, 1, 'W and V would both be active in one region');
});

test('stranding needs consent for exactly the stranded instances', () => {
  const reg = fresh();
  const a = reg.spawn('ABRO'); reg.tick(a, ['A']);                    // in DoneA
  const b = reg.spawn('ABRO');                                         // WaitA + WaitB
  const spec = { id: 'abro-v3', chart: model('abro-v3.sctx') };        // renames, no mapping
  const r1 = reg.deploy(spec);
  assert.equal(r1.deployed, false);
  assert.deepEqual(r1.preview.stranded.map((s) => s.id), [a.id]);
  assert.equal(reg.deploy(spec, { consent: [] }).deployed, false);
  const r2 = reg.deploy(spec, { consent: [a.id] });
  assert.equal(r2.deployed, true);
  assert.equal(a.status, 'stranded');
  assert.equal(b.status, 'active');
  reg.tick(a, ['B']);
  assert.equal(a.status, 'stranded', 'a stranded instance takes no ticks');
});

test('preview is exact: it predicts precisely what the deployment then does', () => {
  for (let seed = 1; seed <= 12; seed++) {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    const reg = fresh();
    const fleet = Array.from({ length: 120 }, () => reg.spawn('ABRO'));
    for (const i of fleet) for (let k = Math.floor(rnd() * 5); k > 0; k--) reg.tick(i, ['A', 'B', 'R'].filter(() => rnd() < 0.3));
    const spec = seed % 2
      ? { id: 'abro-v2', chart: model('abro-v2.sctx'), historyPath: ['WaitB->DoneB'] }
      : { id: 'abro-v3', chart: model('abro-v3.sctx') };
    const p = reg.preview(spec);
    const before = new Map(fleet.map((i) => [i.id, i.version]));
    reg.deploy(spec, { consent: p.stranded.map((r) => r.id) });
    const moved = fleet.filter((i) => i.version !== before.get(i.id) && i.status === 'active').map((i) => i.id).sort();
    const stranded = fleet.filter((i) => i.status === 'stranded').map((i) => i.id).sort();
    assert.deepEqual(moved, p.migrate.map((r) => r.id).sort(), `seed ${seed}: migrate`);
    assert.deepEqual(stranded, p.stranded.map((r) => r.id).sort(), `seed ${seed}: strand`);
  }
});

test('preview diagram renders (ELK layout)', async () => {
  const reg = fresh();
  for (let k = 0; k < 10; k++) { const i = reg.spawn('ABRO'); if (k % 2) reg.tick(i, ['A']); }
  const p = reg.preview({ id: 'abro-v3', chart: model('abro-v3.sctx') });
  const svg = await previewSvg(model('abro-v1.sctx'), p, 'test');
  assert.match(svg, /^<svg/);
  assert.match(svg, /strand 5/);
  assert.match(svg, />DoneA</);
});
