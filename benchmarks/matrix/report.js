// Terminal reporting for the matrix benchmark.
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath }            from 'url';
import { dirname, join }            from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const W = 72;
const hr = (ch = '─', w = W) => ch.repeat(w);

const fmt = {
  num: n => n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
    ? `${(n / 1_000).toFixed(0)}k`
    : String(Math.round(n)),
  µs: n => {
    if (n === undefined || n === null) return '       —';
    if (n < 1000) return `${n.toFixed(1)}µs`.padStart(8);
    return `${(n / 1000).toFixed(2)}ms`.padStart(8);
  },
  bar: (ratio, width = 20) => {
    const filled = Math.max(1, Math.round(Math.min(ratio, 1) * width));
    return '█'.repeat(filled) + '░'.repeat(width - filled);
  },
  pct: ratio => `${(ratio * 100).toFixed(1)}%`.padStart(7),
};

export function printAxisHeader({ axisLabel, baseline, axisName, warmupSecs, measureSecs }) {
  console.log(`\n${hr('═')}`);
  console.log(`  Axis: ${axisLabel}`);
  console.log(hr());
  const fixed = Object.entries(baseline)
    .filter(([k]) => k !== axisName)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
  if (fixed) console.log(`  Fixed: ${fixed}`);
  console.log(`  Warmup ${warmupSecs}s · Measure ${measureSecs}s`);
  console.log(hr('─'));
  console.log(
    `  ${'Tier'.padEnd(38)} ${'ev/s'.padStart(7)}  ${'p50'.padStart(8)}  ${'p99'.padStart(8)}  vs XState`
  );
  console.log(`  ${hr('·', 38)} ${'─'.repeat(7)}  ${'─'.repeat(8)}  ${'─'.repeat(8)}  ─────────`);
}

export function printRow(result, xstateCeiling) {
  const { label, evPerSec, 'p50µs': p50, 'p99µs': p99, note, error } = result;
  const ratio  = xstateCeiling ? evPerSec / xstateCeiling : 1;
  const bar    = fmt.bar(ratio);
  const pct    = xstateCeiling ? fmt.pct(ratio) : ' ceiling';
  const epsStr = evPerSec ? fmt.num(evPerSec).padStart(7) : ' (fail)';

  console.log(`  ${(label ?? 'StateKeep').padEnd(38)} ${epsStr}  ${fmt.µs(p50)}  ${fmt.µs(p99)}  ${bar} ${pct}`);
  if (error) console.log(`    ↳ ERROR: ${error}`);
  else if (note) console.log(`    ↳ ${note}`);
}

export function printSummaryTable(allResults) {
  if (!allResults.length) return;
  console.log(`\n${hr('═')}`);
  console.log('  SUMMARY — All Scenarios (sorted by ev/s)');
  console.log(hr('═'));

  const sorted = [...allResults].sort((a, b) => b.evPerSec - a.evPerSec);
  const maxEps = sorted[0].evPerSec;
  const labelW = Math.max(...sorted.map(r => r.label.length), 20);

  for (const r of sorted) {
    const label  = r.label.padEnd(labelW);
    const epsStr = fmt.num(r.evPerSec).padStart(8);
    const ratio  = r.evPerSec / maxEps;
    const bar    = fmt.bar(ratio, 22);
    const mult   = r.evPerSec === maxEps ? '  (ceiling)' : r.evPerSec === 0 ? '  (failed)' : `  ${(maxEps / r.evPerSec).toFixed(1)}× slower`;
    console.log(`  ${label}  ${epsStr} ev/s  ${bar}${mult}`);
  }
  console.log(hr('═'));
}

export function saveJsonReport(allResults, meta) {
  const dir  = join(__dirname, 'reports');
  mkdirSync(dir, { recursive: true });
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = join(dir, `${ts}.json`);
  const payload = { timestamp: new Date().toISOString(), ...meta, results: allResults };
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}
