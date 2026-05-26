/**
 * benchmarks/apv-fingerprint.js
 *
 * Measures the two performance-critical operations in the APV migration path:
 *
 *   1. FNV-1a fingerprint computation — pure JS, mirrors actorWorker.js exactly.
 *      Runs once per event as actors advance through their lifecycle.
 *      We simulate computing fingerprints from scratch for N actors with M events.
 *
 *   2. computeAccessible — C engine lookup via FFI (if available).
 *      Runs once per actor during a migration deployment.
 *      Given a stored fingerprint, answers: "which definition version does this actor get?"
 *
 * Supports two modes:
 *   - With APV engine: measures both JS fingerprinting and C engine routing
 *   - Without engine (fallback / dev machine): measures JS fingerprinting only
 *
 * Usage:
 *   node --env-file=.env benchmarks/apv-fingerprint.js
 *   ACTOR_COUNT=50000 node --env-file=.env benchmarks/apv-fingerprint.js
 *
 * Does NOT require a running StateKeep server. Loads the engine .so directly.
 */

import { existsSync } from 'fs';
import { resolve }    from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

const ACTOR_COUNT   = Math.max(1000, parseInt(process.env.ACTOR_COUNT   ?? '10000', 10));
const EVENTS_PER_ACTOR = Math.max(10, parseInt(process.env.EVENTS_PER_ACTOR ?? '50',    10));
const WARMUP_ACTORS = Math.floor(ACTOR_COUNT * 0.05);  // 5% warmup, uncounted

// Realistic loan-application event sequence — same length distribution
// as production actors in the benchmarks/shared/scenarios.js loan machine.
const EVENT_POOL = [
  'SUBMITTED', 'DOCS_UPLOADED', 'ASSIGNED_TO_REVIEWER',
  'MANUAL_COMPLIANCE_PASSED', 'FLAGGED_FOR_FRAUD', 'CLEARED',
  'CREDIT_CHECKED', 'APPROVED', 'REJECTED', 'DISBURSED',
  'PAYMENT_RECEIVED', 'FEE_PAID', 'FEE_WAIVED', 'RESUBMITTED',
  'ESCALATED', 'RESOLVED', 'ARCHIVED', 'REOPENED',
];

// ── FNV-1a (mirrors actorWorker.js exactly) ───────────────────────────────────

const FNV_PRIME  = 0x00000100000001B3n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const UINT64_MAX = 0xFFFFFFFFFFFFFFFFn;

function fnv1aUpdate(hash, str) {
  const buf = Buffer.from(String(str), 'utf8');
  for (const byte of buf) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & UINT64_MAX;
  }
  return hash;
}

function computeFingerprint(events) {
  let hash = FNV_OFFSET;
  for (const ev of events) {
    hash = fnv1aUpdate(hash, ev);
  }
  return hash.toString(16).padStart(16, '0');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateActorEvents(actorIndex) {
  // Deterministic sequence per actor so results are reproducible
  const events = [];
  for (let i = 0; i < EVENTS_PER_ACTOR; i++) {
    events.push(EVENT_POOL[(actorIndex * 7 + i * 3) % EVENT_POOL.length]);
  }
  return events;
}

function fmt(ns) {
  if (ns < 1_000)       return `${ns.toFixed(1)} ns`;
  if (ns < 1_000_000)   return `${(ns / 1_000).toFixed(2)} µs`;
  return                       `${(ns / 1_000_000).toFixed(2)} ms`;
}

function fmtThroughput(actorCount, totalNs) {
  const perSec = (actorCount / (totalNs / 1e9)).toFixed(0);
  return `${Number(perSec).toLocaleString()} actors/sec`;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean   = samples.reduce((s, v) => s + v, 0) / samples.length;
  const p50    = sorted[Math.floor(sorted.length * 0.50)];
  const p95    = sorted[Math.floor(sorted.length * 0.95)];
  const p99    = sorted[Math.floor(sorted.length * 0.99)];
  const min    = sorted[0];
  const max    = sorted[sorted.length - 1];
  return { mean, p50, p95, p99, min, max };
}

// ── Benchmark 1: JS FNV-1a fingerprinting ────────────────────────────────────

function benchmarkJsFingerprinting() {
  console.log('\n── Benchmark 1: FNV-1a fingerprint computation (pure JS) ──────────────────');
  console.log(`   Simulating: ${ACTOR_COUNT.toLocaleString()} actors × ${EVENTS_PER_ACTOR} events each`);
  console.log(`   This mirrors the production path in actorWorker.js.\n`);

  // Warmup
  for (let i = 0; i < WARMUP_ACTORS; i++) {
    computeFingerprint(generateActorEvents(i));
  }

  // Measure per-actor (each actor computes its full fingerprint from scratch)
  const perActorNs = [];
  const t0Total = process.hrtime.bigint();

  for (let i = 0; i < ACTOR_COUNT; i++) {
    const events = generateActorEvents(i);
    const t0 = process.hrtime.bigint();
    computeFingerprint(events);
    const t1 = process.hrtime.bigint();
    perActorNs.push(Number(t1 - t0));
  }

  const t1Total = process.hrtime.bigint();
  const totalNs = Number(t1Total - t0Total);

  const s = stats(perActorNs);

  console.log(`   Total time (${ACTOR_COUNT.toLocaleString()} actors):  ${fmt(totalNs)}`);
  console.log(`   Throughput:              ${fmtThroughput(ACTOR_COUNT, totalNs)}`);
  console.log(`   Per-actor timing:`);
  console.log(`     mean  ${fmt(s.mean)}`);
  console.log(`     p50   ${fmt(s.p50)}`);
  console.log(`     p95   ${fmt(s.p95)}`);
  console.log(`     p99   ${fmt(s.p99)}`);
  console.log(`     min   ${fmt(s.min)}`);
  console.log(`     max   ${fmt(s.max)}`);

  // Also measure incremental cost (single event update, production path)
  const singleUpdateSamples = [];
  const hash0 = FNV_OFFSET;
  for (let i = 0; i < ACTOR_COUNT; i++) {
    const t0 = process.hrtime.bigint();
    fnv1aUpdate(hash0, EVENT_POOL[i % EVENT_POOL.length]);
    const t1 = process.hrtime.bigint();
    singleUpdateSamples.push(Number(t1 - t0));
  }
  const singleStats = stats(singleUpdateSamples);
  console.log(`\n   Incremental cost (single event update, production hot path):`);
  console.log(`     mean  ${fmt(singleStats.mean)}  ← cost added per event sent to an actor`);
  console.log(`     p99   ${fmt(singleStats.p99)}`);

  return { totalNs, perActorMeanNs: s.mean, perActorP99Ns: s.p99 };
}

// ── Benchmark 2: C engine computeAccessible ───────────────────────────────────

async function benchmarkCEngineRouting() {
  const enginePath = process.env.STATEKEEP_ENGINE_PATH
    ?? resolve(process.cwd(), 'libapv-engine.so');

  if (!existsSync(enginePath)) {
    console.log('\n── Benchmark 2: C engine computeAccessible ────────────────────────────────');
    console.log(`   Engine not found at: ${enginePath}`);
    console.log(`   Set STATEKEEP_ENGINE_PATH to run this benchmark.`);
    console.log(`   Run on the VPS where libapv-engine.so is present.\n`);
    return null;
  }

  let koffi;
  try {
    const mod = await import('koffi').catch(() => null);
    koffi = mod?.default ?? mod;
  } catch {
    koffi = null;
  }

  if (!koffi) {
    console.log('\n── Benchmark 2: C engine computeAccessible ────────────────────────────────');
    console.log(`   koffi not installed — cannot load engine for standalone benchmark.`);
    console.log(`   Run: npm install koffi in the project root.\n`);
    return null;
  }

  console.log('\n── Benchmark 2: C engine computeAccessible (FFI call) ─────────────────────');
  console.log(`   Engine: ${enginePath}`);
  console.log(`   Measuring per-actor routing lookup cost during migration.\n`);

  try {
    const lib             = koffi.load(enginePath);
    const apv_registry_t  = koffi.opaque('apv_registry_t');
    const RegPtr          = koffi.pointer(apv_registry_t);

    const _create  = lib.func('apv_registry_create',    RegPtr,  []);
    const _destroy = lib.func('apv_registry_destroy',   'void',  [RegPtr]);
    const _tick    = lib.func('apv_clock_tick',         'uint64',[RegPtr]);
    const _register= lib.func('apv_register_changepoint','int',  [RegPtr,'uint64','uint64','uint64','str']);
    const _compute = lib.func('apv_compute_accessible', 'int',   [RegPtr,'uint64','uint64','uint64','uint8 *','size_t']);
    const _fnvInit = lib.func('apv_fnv1a_init',   'uint64', []);
    const _fnvUpd  = lib.func('apv_fnv1a_update', 'uint64', ['uint64','uint8 *','size_t']);
    const _fnvFin  = lib.func('apv_fnv1a_final',  'uint64', ['uint64']);

    const reg = _create();
    if (!reg) { console.log('   ERROR: apv_registry_create returned null.'); return null; }

    // Register one changepoint: actors with MANUAL_COMPLIANCE_PASSED in history → v2
    const tStar = BigInt(_tick(reg));

    // Compute the prefix hash for the target event sequence using the C engine
    const targetEvents = ['SUBMITTED', 'MANUAL_COMPLIANCE_PASSED'];
    let prefixHash = BigInt(_fnvInit());
    for (const ev of targetEvents) {
      const buf = Buffer.from(ev, 'utf8');
      prefixHash = BigInt(_fnvUpd(prefixHash, buf, buf.length));
    }
    prefixHash = BigInt(_fnvFin(prefixHash));

    _register(reg, tStar, prefixHash, 0n, 'loan-v2');

    const currentTime = BigInt(_tick(reg));
    const outBuf      = Buffer.alloc(512, 0);

    // Warmup
    for (let i = 0; i < WARMUP_ACTORS; i++) {
      _compute(reg, prefixHash, 1n, currentTime, outBuf, 512);
    }

    // Measure: computeAccessible per actor (hash lookup, the migration routing cost)
    const perCallNs = [];
    const t0Total   = process.hrtime.bigint();

    for (let i = 0; i < ACTOR_COUNT; i++) {
      // Alternate between matching and non-matching fingerprints
      const fp = i % 2 === 0 ? prefixHash : 0xDEADBEEFn;
      const t0 = process.hrtime.bigint();
      _compute(reg, fp, BigInt(i + 1), currentTime, outBuf, 512);
      const t1 = process.hrtime.bigint();
      perCallNs.push(Number(t1 - t0));
    }

    const t1Total = process.hrtime.bigint();
    const totalNs = Number(t1Total - t0Total);

    const s = stats(perCallNs);

    console.log(`   Total time (${ACTOR_COUNT.toLocaleString()} routing lookups): ${fmt(totalNs)}`);
    console.log(`   Throughput:              ${fmtThroughput(ACTOR_COUNT, totalNs)}`);
    console.log(`   Per-actor timing:`);
    console.log(`     mean  ${fmt(s.mean)}`);
    console.log(`     p50   ${fmt(s.p50)}`);
    console.log(`     p95   ${fmt(s.p95)}`);
    console.log(`     p99   ${fmt(s.p99)}`);
    console.log(`     min   ${fmt(s.min)}`);
    console.log(`     max   ${fmt(s.max)}`);

    try { _destroy(reg); } catch {}

    return { totalNs, perActorMeanNs: s.mean, perActorP99Ns: s.p99 };

  } catch (err) {
    console.log(`   ERROR loading engine: ${err.message}\n`);
    return null;
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

function printSummary(jsBench, cBench) {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('══════════════════════════════════════════════════════════════\n');

  console.log(`  FNV-1a fingerprinting (JS, ${EVENTS_PER_ACTOR} events/actor):`);
  console.log(`    mean per actor:  ${fmt(jsBench.perActorMeanNs)}`);
  console.log(`    p99  per actor:  ${fmt(jsBench.perActorP99Ns)}`);

  const jsCategory = jsBench.perActorMeanNs < 1_000   ? 'sub-microsecond' :
                     jsBench.perActorMeanNs < 100_000  ? 'microseconds'    :
                     jsBench.perActorMeanNs < 1_000_000? 'hundreds of µs'  : 'milliseconds';
  console.log(`    range:           ${jsCategory}`);

  if (cBench) {
    console.log(`\n  C engine computeAccessible (FFI routing lookup):`);
    console.log(`    mean per actor:  ${fmt(cBench.perActorMeanNs)}`);
    console.log(`    p99  per actor:  ${fmt(cBench.perActorP99Ns)}`);
    const cCategory = cBench.perActorMeanNs < 1_000   ? 'sub-microsecond' :
                      cBench.perActorMeanNs < 100_000  ? 'microseconds'    : 'milliseconds';
    console.log(`    range:           ${cCategory}`);

    if (jsBench.perActorMeanNs > 0 && cBench.perActorMeanNs > 0) {
      const ratio = (jsBench.perActorMeanNs / cBench.perActorMeanNs).toFixed(1);
      console.log(`    JS/C ratio:      ${ratio}× (JS fingerprint cost vs C routing cost)`);
    }
  } else {
    console.log(`\n  C engine routing:  not measured (engine not available on this machine)`);
    console.log(`  → Run on the VPS with STATEKEEP_ENGINE_PATH set for full results.`);
  }

  // Verdict for the docs claim
  console.log('\n  DOCS CLAIM CHECK:');
  console.log('  Claim: "FNV-1a fingerprinting ... runs in microseconds per actor"');
  const mean = jsBench.perActorMeanNs;
  if (mean < 1_000) {
    console.log(`  JS result: ${fmt(mean)} mean → claim accurate (sub-µs, which is faster than "microseconds")`);
  } else if (mean < 1_000_000) {
    console.log(`  JS result: ${fmt(mean)} mean → claim ACCURATE ✓`);
  } else {
    console.log(`  JS result: ${fmt(mean)} mean → claim OVERSTATED — update to "${jsCategory}"`);
  }

  if (cBench) {
    const cmean = cBench.perActorMeanNs;
    if (cmean < 1_000_000) {
      console.log(`  C result:  ${fmt(cmean)} mean → claim ACCURATE ✓`);
    } else {
      console.log(`  C result:  ${fmt(cmean)} mean → claim OVERSTATED for C engine path`);
    }
  }

  console.log('');
}

// ── Run ───────────────────────────────────────────────────────────────────────

console.log('══════════════════════════════════════════════════════════════');
console.log('  StateKeep APV Fingerprint Benchmark');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  Actors:         ${ACTOR_COUNT.toLocaleString()}`);
console.log(`  Events/actor:   ${EVENTS_PER_ACTOR}`);
console.log(`  Total events:   ${(ACTOR_COUNT * EVENTS_PER_ACTOR).toLocaleString()}`);

const jsBench = benchmarkJsFingerprinting();
const cBench  = await benchmarkCEngineRouting();

printSummary(jsBench, cBench);
