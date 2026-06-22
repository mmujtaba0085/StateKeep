/**
 * benchmarks/comparison/run.js
 *
 * Five-tier throughput comparison:
 *   Tier 1 — Pure XState                          (in-process, no persistence)
 *   Tier 2 — XState + APV                         (in-process, Math.imul FNV-32 per event)
 *   Tier 3 — StateKeep embedded, buffered         (50ms write window, default)
 *   Tier 4 — StateKeep embedded, sync             (flush per event, zero crash window)
 *   Tier 5 — StateKeep embedded, async            (hot registry only, no write buffer)
 *
 * Usage:
 *   node benchmarks/comparison/run.js
 */

import { run as runXState }    from './tier1-xstate.js';
import { run as runXStateApv } from './tier2-xstate-apv.js';
import { runDurability, runConcurrent, cleanup } from './tier3-statekeep.js';

const fmt = {
  num: (n) => n.toLocaleString('en-US'),
  µs:  (n) => n < 1000 ? `${n.toFixed(1)}µs` : `${(n / 1000).toFixed(2)}ms`,
  bar: (ratio, width = 30) => {
    const filled = Math.max(1, Math.round(ratio * width));
    return '█'.repeat(filled) + '░'.repeat(width - filled);
  },
};

function hr(char = '─', width = 66) { return char.repeat(width); }

function printResult(r, baseline) {
  const ratio = baseline ? r.evPerSec / baseline : 1;
  const bar   = fmt.bar(Math.min(ratio, 1));

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

  const maxEps  = Math.max(...results.map(r => r.evPerSec));
  const labelW  = Math.max(...results.map(r => r.label.length)) + 2;

  for (const r of results) {
    const label = r.label.padEnd(labelW);
    const eps   = fmt.num(r.evPerSec).padStart(12);
    const ratio = r.evPerSec / maxEps;
    const bar   = fmt.bar(ratio, 20);
    const mult  = r.evPerSec === maxEps ? '  (baseline)' : `  ${(maxEps / r.evPerSec).toFixed(1)}x slower`;
    console.log(`  ${label} ${eps} ev/s  ${bar}${mult}`);
  }
  console.log(hr('═'));
}

console.log(`\n${hr('═')}`);
console.log('  StateKeep Benchmark — XState vs XState+APV vs StateKeep (3 durability modes)');
console.log(hr('═'));
console.log('  Machine: 3-state order flow  idle → processing → done → idle');
console.log('  Cycle  : PROCESS → COMPLETE → RESET  (3 events/cycle)');
console.log(hr('─'));

const results = [];

process.stdout.write('\n  [1/5] Pure XState ... ');
const r1 = await runXState({ warmupCycles: 5_000, measureCycles: 100_000 });
console.log('done');
printResult(r1, null);
results.push(r1);

process.stdout.write('\n  [2/5] XState + APV fingerprinting ... ');
const r2 = await runXStateApv({ warmupCycles: 5_000, measureCycles: 100_000 });
console.log('done');
printResult(r2, null);
results.push(r2);

process.stdout.write('\n  [3/5] StateKeep embedded — buffered (default) ... ');
const r3 = await runDurability('buffered', { warmupCycles: 10, measureCycles: 200 });
console.log('done');
printResult(r3, r1.evPerSec);
results.push(r3);

process.stdout.write('\n  [4/5] StateKeep embedded — sync (zero loss) ... ');
const r4 = await runDurability('sync', { warmupCycles: 10, measureCycles: 200 });
console.log('done');
printResult(r4, r1.evPerSec);
results.push(r4);

process.stdout.write('\n  [5/5] StateKeep embedded — async (hot registry only) ... ');
const r5 = await runDurability('async', { warmupCycles: 10, measureCycles: 200 });
console.log('done');
printResult(r5, r1.evPerSec);
results.push(r5);

process.stdout.write('\n  Concurrent benchmark (10 actors, buffered) ... ');
const r3c = await runConcurrent({ concurrency: 10, eventsPerActor: 30 });
console.log('done');
console.log(`\n  ${r3c.label}`);
console.log(`  Events/sec: ${fmt.num(r3c.evPerSec)}  (${fmt.num(r3c.totalEvents)} total in ${r3c.elapsedMs.toFixed(0)}ms)`);

printSummary(results);

await cleanup();
