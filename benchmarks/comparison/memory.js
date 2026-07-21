/**
 * benchmarks/comparison/memory.js
 *
 * Per-actor memory benchmark:
 *   A - XState + event-log replay   (full event history per actor in JS heap)
 *   B - XState + APV overlay        (one FNV-32 uint32 per actor in JS heap)
 *   C - Plain XState snapshot       (current state only - baseline)
 *   D - StateKeep hot LRU cache     (main-thread heap; workers in RSS only)
 *
 * Tiers A/B/C replicate paper Section 12 Table 1/2 conditions.
 * Tier D measures StateKeep operational memory (new - not in the paper).
 *
 * Run: node --expose-gc benchmarks/comparison/memory.js
 */

delete process.env.STATEKEEP_ENCRYPTION_KEY;

const COUNTS           = [1_000, 10_000, 100_000, 500_000, 1_000_000];
const EVENTS_PER_ACTOR = 50;

if (typeof global.gc !== 'function') {
  console.error('Run with: node --expose-gc benchmarks/comparison/memory.js');
  process.exit(1);
}

function gc()     { global.gc(); global.gc(); }
function heapMB() { return process.memoryUsage().heapUsed / 1024 / 1024; }
function rssMB()  { return process.memoryUsage().rss      / 1024 / 1024; }
function fmt2(n)  { return n.toFixed(2); }
function fmtB(b) {
  if (b <    1024) return `${b.toFixed(0)} B`;
  if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1048576).toFixed(2)} MB`;
}
function hr(c='─',w=72){ return c.repeat(w); }

// Tier A: store full event array per actor (replay approach)
function measureEventReplay(n) {
  const TYPES = ['PROCESS','COMPLETE','RESET'];
  gc();
  const before = heapMB();
  const store = new Array(n);
  for (let i = 0; i < n; i++) {
    const evs = new Array(EVENTS_PER_ACTOR);
    for (let e = 0; e < EVENTS_PER_ACTOR; e++) evs[e] = { type: TYPES[e%3], seqNo: e };
    store[i] = evs;
  }
  gc();
  const after = heapMB();
  void store[0];
  return { totalMB: after - before, perActor: (after - before) * 1048576 / n };
}

// Tier B: store one uint32 hash per actor (APV approach)
function measureApvOverlay(n) {
  gc();
  const before = heapMB();
  const hashes = new Uint32Array(n);
  const ids    = new Array(n);
  for (let i = 0; i < n; i++) {
    hashes[i] = (0x811c9dc5 ^ i) >>> 0;
    ids[i]    = `a${i.toString(36)}`;
  }
  gc();
  const after = heapMB();
  void hashes[0]; void ids[0];
  return { totalMB: after - before, perActor: (after - before) * 1048576 / n };
}

// Tier C: live XState actors with current state only (baseline - no routing data)
async function measureXStateSnapshot(n) {
  const { createMachine, createActor } = await import('../../node_modules/xstate/dist/xstate.cjs.mjs');
  const machine = createMachine({
    id: 'order', initial: 'idle',
    states: {
      idle:       { on: { PROCESS:  'processing' } },
      processing: { on: { COMPLETE: 'done'       } },
      done:       { on: { RESET:    'idle'        } },
    },
  });
  gc();
  const before = heapMB();
  const actors = new Array(n);
  for (let i = 0; i < n; i++) { const a = createActor(machine); a.start(); actors[i] = a; }
  gc();
  const after = heapMB();
  void actors[0];
  for (const a of actors) { try { a.stop(); } catch {} }
  return { totalMB: after - before, perActor: (after - before) * 1048576 / n };
}

// Tier D: StateKeep hot LRU cache memory
async function measureStateKeepHot(counts) {
  const { mkdtempSync, rmSync } = await import('fs');
  const { join }                = await import('path');
  const { tmpdir }              = await import('os');
  const { createStateKeep }     = await import('../../src/lib/index.js');

  const tmpDir = mkdtempSync(join(tmpdir(), 'sk-mem-'));
  const sk     = await createStateKeep({ dbPath: join(tmpDir, 'mem.db') });

  const { id: defId } = await sk.deployDefinition({
    id: 'order', initial: 'idle',
    states: {
      idle:       { on: { PROCESS:  'processing' } },
      processing: { on: { COMPLETE: 'done'       } },
      done:       { on: { RESET:    'idle'        } },
    },
  });

  // Baseline after full startup
  gc();
  const baseHeap = heapMB();
  const baseRss  = rssMB();
  const rows = [];

  for (const n of counts) {
    const ids = [];
    for (let i = 0; i < n; i++) {
      const a = await sk.spawnActor({ definitionId: defId });
      ids.push(a.id);
    }
    // One event per actor to hydrate into hot cache
    for (const id of ids) await sk.sendEvent(id, { type: 'PROCESS' });
    await new Promise(r => setTimeout(r, 150));
    gc();
    const heap = heapMB();
    const rss  = rssMB();
    rows.push({
      count:        n,
      heapDeltaMB:  heap - baseHeap,
      rssDeltaMB:   rss  - baseRss,
      perActorHeap: (heap - baseHeap) * 1048576 / n,
      perActorRss:  (rss  - baseRss)  * 1048576 / n,
    });
    process.stdout.write(` ${n.toLocaleString()}`);
  }

  await sk.close();
  try { rmSync(tmpDir, { recursive: true }); } catch {}
  return { baseHeap, baseRss, rows };
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n${hr('=')}`);
console.log('  StateKeep Memory Benchmark');
console.log(hr('='));
console.log(`  Scenario : ${EVENTS_PER_ACTOR} events/actor (paper Section 12 condition)`);
console.log('  GC       : --expose-gc, double-GC before each measurement');
console.log(hr());

// Tier A
process.stdout.write('\n  [A] Event-log replay ...');
const replayRows = [];
for (const n of COUNTS) {
  if (n > 500_000) { process.stdout.write(` ${n.toLocaleString()}(skipped-OOM risk)`); continue; }
  replayRows.push({ count: n, ...measureEventReplay(n) });
  process.stdout.write(` ${n.toLocaleString()}`);
}
console.log(' done\n');
console.log('  Tier A - XState + event-log replay');
console.log(hr('.'));
console.log('       Actors       Total MB    Per-actor');
console.log(hr('.'));
for (const r of replayRows)
  console.log(`  ${r.count.toLocaleString().padStart(11)}  ${fmt2(r.totalMB).padStart(10)}  ${fmtB(r.perActor).padStart(10)}`);

// Tier B
process.stdout.write('\n  [B] APV overlay ...');
const apvRows = [];
for (const n of COUNTS) {
  apvRows.push({ count: n, ...measureApvOverlay(n) });
  process.stdout.write(` ${n.toLocaleString()}`);
}
console.log(' done\n');
console.log('  Tier B - XState + APV overlay (uint32 hash per actor)');
console.log(hr('.'));
console.log('       Actors       Total MB    Per-actor');
console.log(hr('.'));
for (const r of apvRows)
  console.log(`  ${r.count.toLocaleString().padStart(11)}  ${fmt2(r.totalMB).padStart(10)}  ${fmtB(r.perActor).padStart(10)}`);

const rA = replayRows.find(r => r.count === 100_000);
const rB = apvRows.find(r => r.count === 100_000);
if (rA && rB) {
  const ratio = rA.totalMB / rB.totalMB;
  console.log(`\n  Paper comparison (100k actors, ${EVENTS_PER_ACTOR} events each):`);
  console.log(`    Event replay  : ${fmt2(rA.totalMB)} MB  (${fmtB(rA.perActor)}/actor)`);
  console.log(`    APV overlay   : ${fmt2(rB.totalMB)} MB  (${fmtB(rB.perActor)}/actor)`);
  console.log(`    Memory saving : ${((1 - 1/ratio)*100).toFixed(1)}% less with APV`);
}

const rB500k = apvRows.find(r => r.count === 500_000);
const rB1M   = apvRows.find(r => r.count === 1_000_000);
if (rB500k) console.log(`    APV at 500k   : ${fmt2(rB500k.totalMB)} MB`);
if (rB1M)   console.log(`    APV at 1M     : ${fmt2(rB1M.totalMB)} MB`);

// Tier C
const SNAP_COUNTS = [1_000, 10_000, 100_000];
process.stdout.write('\n  [C] XState snapshot ...');
const snapRows = [];
for (const n of SNAP_COUNTS) {
  snapRows.push({ count: n, ...await measureXStateSnapshot(n) });
  process.stdout.write(` ${n.toLocaleString()}`);
}
console.log(' done\n');
console.log('  Tier C - Plain XState snapshot (actor baseline, no routing data)');
console.log(hr('.'));
console.log('       Actors       Total MB    Per-actor');
console.log(hr('.'));
for (const r of snapRows)
  console.log(`  ${r.count.toLocaleString().padStart(11)}  ${fmt2(r.totalMB).padStart(10)}  ${fmtB(r.perActor).padStart(10)}`);

const rC100k = snapRows.find(r => r.count === 100_000);
if (rA && rB && rC100k) {
  console.log(`\n  Three-way at 100k actors:`);
  console.log(`    Event replay  : ${fmt2(rA.totalMB)} MB`);
  console.log(`    XState snap   : ${fmt2(rC100k.totalMB)} MB`);
  console.log(`    APV overlay   : ${fmt2(rB.totalMB)} MB`);
  console.log(`    APV vs snap   : ${((rB.totalMB - rC100k.totalMB)/rC100k.totalMB*100).toFixed(1)}% overhead`);
}

// Tier D
const SK_COUNTS = [100, 500, 1_000, 5_000, 10_000];
process.stdout.write('\n  [D] StateKeep hot LRU cache ...');
const skData = await measureStateKeepHot(SK_COUNTS);
console.log(' done\n');
console.log(`  Tier D - StateKeep hot LRU cache`);
console.log(`  Startup baseline: heap=${fmt2(skData.baseHeap)}MB  rss=${fmt2(skData.baseRss)}MB`);
console.log('  heapUsed = main thread only.  rss = full process (incl. 20 worker threads).');
console.log(hr('.'));
console.log('  Actors   Heap delta MB   RSS delta MB   Per-actor heap    Per-actor rss');
console.log(hr('.'));
for (const r of skData.rows)
  console.log(
    `  ${r.count.toLocaleString().padStart(6)}` +
    `  ${fmt2(r.heapDeltaMB).padStart(14)}` +
    `  ${fmt2(r.rssDeltaMB).padStart(14)}` +
    `  ${fmtB(r.perActorHeap).padStart(16)}` +
    `  ${fmtB(r.perActorRss).padStart(14)}`
  );

console.log(`\n${hr('=')}`);
console.log('  Notes:');
console.log('  - Tier D startup overhead (workers) already subtracted from deltas.');
console.log('  - Actors beyond HOT_REGISTRY_SIZE (10k default) evict to SQLite; delta flattens.');
console.log('  - Paper Table 1 comparison: Tier A vs Tier B vs Tier C at 100k actors.');
console.log(hr('='));
