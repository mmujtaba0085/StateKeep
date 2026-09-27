/**
 * test/test_apv_conformance.js — the shipped APV engine (src/ffi/apv-engine.mjs)
 * against a reference model of its documented rules, on thousands of random
 * operation sequences (seeded, so a failure names its seed).
 *
 * Rules modelled (see docs/apv.md):
 *   register(t*, prefix, r, child)   a location is (t*, prefix); only a higher
 *                                    refinement replaces its target; r = 0 is refused
 *   accessible(prefix, T)            the change-point with the smallest t* >= T for
 *                                    that prefix; the wildcard prefix 0 applies to
 *                                    everyone and wins only when strictly earlier
 *   parallel register / accessible   selectors are sets of region fingerprints; an
 *                                    actor matches a selector contained in its own set;
 *                                    at the earliest t* with a match: more regions,
 *                                    then higher refinement, then smaller composed hash,
 *                                    then smaller id. A second selector of the same size
 *                                    at one t* with a different target is refused (-2)
 *                                    unless a larger selector inside their union wins
 *   clock                            strictly increasing from 1
 *   fnv1a                            64-bit FNV-1a
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const FNV_OFF = 0xcbf29ce484222325n, FNV_PRIME = 0x100000001b3n, M64 = (1n << 64n) - 1n;
const fnv = (bytes, h = FNV_OFF) => { for (const b of bytes) { h ^= BigInt(b); h = (h * FNV_PRIME) & M64; } return h; };
const le = (x) => { const b = []; for (let i = 0n; i < 8n; i++) b.push(Number((x >> (8n * i)) & 0xffn)); return b; };
const compose = (hs) => [...hs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).reduce((h, x) => fnv(le(x), h), FNV_OFF);

class Ref {
  cps = new Map(); par = new Map(); clock = 0n;
  register(t, ph, r, child) {
    if (r === 0n) return -1;
    const k = `${t}|${ph}`;
    if (this.cps.has(k) && r <= this.cps.get(k).r) return 0;
    this.cps.set(k, { t, ph, r, child });
    return 0;
  }
  compute(ph, T) {
    const min = (p) => [...this.cps.values()].filter((c) => c.ph === p && c.t >= T).sort((a, b) => (a.t < b.t ? -1 : 1))[0];
    let best = min(ph);
    if (ph !== 0n) { const w = min(0n); if (w && (!best || w.t < best.t)) best = w; }
    return best ? best.child : '-';
  }
  registerPar(t, hs, r, child) {
    if (r === 0n || hs.length === 0) return -1;
    const k = `${t}|${compose(hs)}`;
    if (!(this.par.has(k) && r <= this.par.get(k).r)) {
      const sameT = [...this.par.entries()].filter(([kk, e]) => e.t === t && kk !== k).map(([, e]) => e);
      for (const e of sameT) {
        if (e.hs.length === hs.length && e.child !== child) {
          const union = new Set([...e.hs, ...hs]);
          if (!sameT.some((f) => f.hs.length > hs.length && f.hs.every((x) => union.has(x)))) return -2;
        }
      }
    }
    if (this.par.has(k) && r <= this.par.get(k).r) return 0;
    this.par.set(k, { t, hs: [...hs], r, child, c: compose(hs) });
    return 0;
  }
  computePar(hs, T) {
    const actor = new Set(hs);
    const times = [...new Set([...this.par.values()].map((e) => e.t))].filter((t) => t >= T).sort((a, b) => (a < b ? -1 : 1));
    for (const t of times) {
      const c = [...this.par.values()].filter((e) => e.t === t && e.hs.every((x) => actor.has(x)));
      if (c.length) {
        c.sort((a, b) => (b.hs.length - a.hs.length) || (a.r === b.r ? 0 : a.r > b.r ? -1 : 1)
          || (a.c === b.c ? 0 : a.c < b.c ? -1 : 1) || (a.child < b.child ? -1 : a.child > b.child ? 1 : 0));
        return c[0].child;
      }
    }
    return '-';
  }
}

function rng(seed) {
  let s = seed >>> 0;
  const r = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { r, int: (a, b) => a + Math.floor(r() * (b - a + 1)), pick: (a) => a[Math.floor(r() * a.length)], big: () => BigInt(Math.floor(r() * 2 ** 32)) << 32n | BigInt(Math.floor(r() * 2 ** 32)) };
}

test('shipped APV engine matches the reference model on random operation sequences', async () => {
  const { default: createModule } = await import('../src/ffi/apv-engine.mjs');
  const SCRIPTS = Number(process.env.APV_CONFORMANCE_SCRIPTS ?? 400);
  const seed0 = Number(process.env.APV_CONFORMANCE_SEED ?? Date.now() % 1e9);
  for (let n = 0; n < SCRIPTS; n++) {
    const w = await createModule();
    const reg = w._apv_registry_create();
    const out = w._malloc(512);
    const str = (s) => { const b = new TextEncoder().encode(s + '\0'); const p = w._malloc(b.length); w.HEAPU8.set(b, p); return p; };
    const arr = (hs) => { const p = w._malloc(Math.max(8, hs.length * 8)); const dv = new DataView(w.HEAPU8.buffer); hs.forEach((h, i) => dv.setBigUint64(p + i * 8, h, true)); return p; };
    const g = rng(seed0 + n);
    const ref = new Ref();
    const T = BigInt(g.pick([8, 30, 200]));
    const phs = [0n, ...Array.from({ length: g.pick([2, 5, 12]) }, g.big)];
    const pool = Array.from({ length: 6 }, g.big);
    const kids = Array.from({ length: 8 }, (_, i) => `def-${i}`);
    const ops = [];
    for (let k = 0, m = g.int(5, 120); k < m; k++) {
      const x = g.r();
      let op, got, want;
      if (x < 0.35) {
        const t = BigInt(g.int(0, Number(T))), ph = g.pick(phs), r = BigInt(g.pick([0, 1, 1, 2, 3, 7])), c = g.pick(kids);
        op = `register ${t} ${ph} ${r} ${c}`; const p = str(c); got = w._apv_register_changepoint(reg, t, ph, r, p); w._free(p); want = ref.register(t, ph, r, c);
      } else if (x < 0.7) {
        const ph = g.r() < 0.9 ? g.pick(phs) : g.big(), t = BigInt(g.int(0, Number(T) + 2));
        op = `accessible ${ph} ${t}`; const rc = w._apv_compute_accessible(reg, ph, t, 0n, out, 512); got = rc === 1 ? w.UTF8ToString(out, 512) : rc === 0 ? '-' : 'ERR'; want = ref.compute(ph, t);
      } else if (x < 0.82) {
        const hs = [...pool].sort(() => g.r() - 0.5).slice(0, g.int(1, 3)), t = BigInt(g.int(0, Number(T))), r = BigInt(g.pick([1, 2, 3])), c = g.pick(kids);
        op = `registerParallel ${t} [${hs}] ${r} ${c}`; const p = arr(hs), q = str(c); got = w._apv_register_changepoint_parallel(reg, t, p, hs.length, r, q); w._free(p); w._free(q); want = ref.registerPar(t, hs, r, c);
      } else if (x < 0.94) {
        const hs = [...pool].sort(() => g.r() - 0.5).slice(0, g.int(1, 6)), t = BigInt(g.int(0, Number(T) + 2));
        op = `accessibleParallel [${hs}] ${t}`; const p = arr(hs); const rc = w._apv_compute_accessible_parallel(reg, p, hs.length, t, 0n, out, 512); w._free(p);
        got = rc === 1 ? w.UTF8ToString(out, 512) : rc === 0 ? '-' : 'ERR'; want = ref.computePar(hs, t);
      } else {
        op = 'clockTick'; got = BigInt.asUintN(64, BigInt(w._apv_clock_tick(reg))); ref.clock += 1n; want = ref.clock;
      }
      ops.push(op);
      assert.deepEqual(got, want, `seed ${seed0 + n}, operation #${k}: ${op}\nexpected ${want}, engine returned ${got}\nafter:\n${ops.slice(-20).join('\n')}`);
    }
    w._apv_registry_destroy(reg);
  }
});

test('FNV-1a matches the reference', async () => {
  const { default: createModule } = await import('../src/ffi/apv-engine.mjs');
  const w = await createModule();
  for (const s of ['', 'a', 'abc', 'statekeep.region.v1', 'x'.repeat(1000)]) {
    const b = new TextEncoder().encode(s); const p = w._malloc(Math.max(1, b.length)); w.HEAPU8.set(b, p);
    assert.equal(BigInt.asUintN(64, w._apv_fnv1a_final(w._apv_fnv1a_update(w._apv_fnv1a_init(), p, b.length))), fnv(b), s.slice(0, 20));
    w._free(p);
  }
});
