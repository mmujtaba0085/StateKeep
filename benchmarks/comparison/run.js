/**
 * benchmarks/comparison/run.js
 *
 * Three-tier throughput comparison:
 *   Tier 1 — Pure XState          (in-process, no persistence)
 *   Tier 2 — XState + APV         (in-process, APV fingerprint per event)
 *   Tier 3 — StateKeep            (HTTP API + SQLite + worker pool)
 *
 * Usage (Windows, no WSL needed for Tiers 1 & 2):
 *   node benchmarks/comparison/run.js
 *   node benchmarks/comparison/run.js --skip-statekeep
 *   node benchmarks/comparison/run.js --statekeep-url https://statekeep.161-97-163-210.nip.io
 *
 * For Tier 3, start StateKeep first:
 *   In WSL: bash benchmarks/comparison/start-statekeep.sh
 *   Or set: STATEKEEP_URL=https://statekeep.161-97-163-210.nip.io
 */

import { run as runXState }       from './tier1-xstate.js';
import { run as runXStateApv }    from './tier2-xstate-apv.js';
import { run as runStateKeep, runConcurrent, checkServer } from './tier3-statekeep.js';

// ── CLI flags ─────────────────────────────────────────────────────────────────
const args         = process.argv.slice(2);
const skipSK       = args.includes('--skip-statekeep');
const skUrlIdx     = args.indexOf('--statekeep-url');
if (skUrlIdx !== -1) process.env.STATEKEEP_URL = args[skUrlIdx + 1];

// ── Formatting ────────────────────────────────────────────────────────────────
const fmt = {
  num:    (n) => n.toLocaleString('en-US'),
  µs:     (n) => n < 1000 ? `${n.toFixed(1)}µs` : `${(n / 1000).toFixed(2)}ms`,
  bar:    (ratio, width = 30) => {
    const filled = Math.max(1, Math.round(ratio * width));
    return '█'.repeat(filled) + '░'.repeat(width - filled);
  },
};

function hr(char = '─', width = 66) { return char.repeat(width); }

function printResult(r, baseline) {
  const ratio    = baseline ? r.evPerSec / baseline : 1;
  const barWidth = 30;
  const bar      = fmt.bar(Math.min(ratio, 1), barWidth);

  console.log(`\n  ${r.label}`);
  console.log(`  ${hr('·', 62)}`);
  console.log(`  Note      : ${r.note}`);
  console.log(`  Events    : ${fmt.num(r.totalEvents)} total  |  ${fmt.num(r.evPerSec)} events/sec`);
  if (r.p50 !== undefined) {
    console.log(`  Latency   : p50=${fmt.µs(r.p50)}  p95=${fmt.µs(r.p95)}  p99=${fmt.µs(r.p99)}`);
  }
  if (baseline) {
    const speedStr = ratio >= 1
      ? `${ratio.toFixed(1)}x faster than StateKeep`
      : `${(1 / ratio).toFixed(0)}x slower than baseline`;
    console.log(`  Relative  : ${bar} ${(ratio * 100).toFixed(1)}% (${speedStr})`);
  }
}

function printSummary(results) {
  console.log(`\n${hr('═')}`);
  console.log('  SUMMARY');
  console.log(hr('═'));

  const maxEps = Math.max(...results.map(r => r.evPerSec));
  const labelW = Math.max(...results.map(r => r.label.length)) + 2;

  for (const r of results) {
    const label   = r.label.padEnd(labelW);
    const eps     = fmt.num(r.evPerSec).padStart(12);
    const ratio   = r.evPerSec / maxEps;
    const bar     = fmt.bar(ratio, 20);
    const mult    = r.evPerSec === maxEps ? '  (baseline)' : `  ${(maxEps / r.evPerSec).toFixed(1)}x slower`;
    console.log(`  ${label} ${eps} ev/s  ${bar}${mult}`);
  }

  // Explain the gap
  const sk = results.find(r => r.label.startsWith('StateKeep'));
  if (sk) {
    const xs = results.find(r => r.label === 'Pure XState');
    if (xs) {
      const gap = Math.round(xs.evPerSec / sk.evPerSec);
      console.log(`\n  The ${fmt.num(gap)}x gap is the cost of persistence, HTTP transport,`);
      console.log(`  SQLite writes, and the worker pool — paid once per event so that`);
      console.log(`  actors survive restarts, scale to millions of instances, and`);
      console.log(`  migrate zero-downtime with APV across definition versions.`);
    }
  }
  console.log(hr('═'));
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log(`\n${hr('═')}`);
console.log('  StateKeep Benchmark — XState vs XState+APV vs StateKeep');
console.log(hr('═'));
console.log('  Machine: 3-state order flow  idle → processing → done → idle');
console.log('  Cycle  : PROCESS → COMPLETE → RESET  (3 events/cycle)');
console.log(hr('─'));

const results = [];

// ── Tier 1: Pure XState ───────────────────────────────────────────────────────
process.stdout.write('\n  [1/3] Pure XState ... ');
const r1 = await runXState({ warmupCycles: 5_000, measureCycles: 100_000 });
console.log('done');
printResult(r1, null);
results.push(r1);

// ── Tier 2: XState + APV ──────────────────────────────────────────────────────
process.stdout.write('\n  [2/3] XState + APV fingerprinting ... ');
const r2 = await runXStateApv({ warmupCycles: 5_000, measureCycles: 100_000 });
console.log('done');
printResult(r2, null);
results.push(r2);

// ── Tier 3: StateKeep ─────────────────────────────────────────────────────────
if (skipSK) {
  console.log('\n  [3/3] StateKeep — skipped (--skip-statekeep)');
} else {
  process.stdout.write('\n  [3/3] StateKeep — checking server ... ');
  const health = await checkServer();
  if (!health) {
    console.log('NOT REACHABLE\n');
    console.log('  To run Tier 3, start StateKeep first:');
    console.log('    WSL:  bash benchmarks/comparison/start-statekeep.sh');
    console.log('    VPS:  node benchmarks/comparison/run.js \\');
    console.log('            --statekeep-url https://statekeep.161-97-163-210.nip.io');
    console.log('  Then re-run: node benchmarks/comparison/run.js\n');
  } else {
    console.log(`up (engine: ${health.engine})`);

    process.stdout.write('  Running sequential benchmark ... ');
    const r3 = await runStateKeep({ warmupCycles: 10, measureCycles: 200 });
    console.log('done');
    printResult(r3, r1.evPerSec);
    results.push(r3);

    process.stdout.write('\n  Running concurrent benchmark (10 actors) ... ');
    const r3c = await runConcurrent({ concurrency: 10, eventsPerActor: 30 });
    console.log('done');
    console.log(`\n  ${r3c.label}`);
    console.log(`  Events/sec: ${fmt.num(r3c.evPerSec)}  (${fmt.num(r3c.totalEvents)} total in ${r3c.elapsedMs.toFixed(0)}ms)`);
  }
}

printSummary(results);
