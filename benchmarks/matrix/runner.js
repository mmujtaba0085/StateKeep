/**
 * benchmarks/matrix/runner.js
 *
 * Matrix benchmark — sweeps variable axes one at a time, keeping all other
 * variables at baseline. Runs XState tiers in-process and StateKeep as an
 * isolated child process per scenario.
 *
 * Usage:
 *   node benchmarks/matrix/runner.js                  # full sweep, all axes
 *   node benchmarks/matrix/runner.js --axis=durability
 *   node benchmarks/matrix/runner.js --axis=concurrency --machine=complex
 *   MEASURE_SECS=30 node benchmarks/matrix/runner.js --axis=encryption
 *
 * Output: terminal summary + benchmarks/matrix/reports/<timestamp>.json
 *
 * Run on WSL/Linux (better-sqlite3 requires Linux).
 * For published numbers, run on the VPS with PM2 + Caddy stopped first.
 */

import { spawn }          from 'child_process';
import { fileURLToPath }  from 'url';
import { dirname, join }  from 'path';

import { run    as runXState   } from './harness/xstate.js';
import { run    as runXStateApv} from './harness/xstate-apv.js';
import * as simpleMachine        from './machines/simple.js';
import * as complexMachine       from './machines/complex.js';
import { AXES, BASELINE, TIMING } from './config.js';
import { printAxisHeader, printRow, printSummaryTable, saveJsonReport } from './report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI ─────────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const axisArg    = args.find(a => a.startsWith('--axis='))?.slice(7)   ?? 'all';
const machineArg = args.find(a => a.startsWith('--machine='))?.slice(10) ?? 'all';

const MACHINES = { simple: simpleMachine, complex: complexMachine };
const selectedAxes    = axisArg    === 'all' ? Object.keys(AXES)           : [axisArg];
const selectedMachines = machineArg === 'all' ? ['simple', 'complex']       : [machineArg];

const { warmupSecs, measureSecs } = TIMING;

// ── StateKeep child runner ───────────────────────────────────────────────────
// Build a clean environment: strip the host's encryption key so the child's
// own config is the only source of truth.
const BASE_ENV = { ...process.env };
delete BASE_ENV.STATEKEEP_ENCRYPTION_KEY;

function runStateKeepChild(scenarioConfig) {
  return new Promise((resolve) => {
    const cfg = { ...BASELINE, ...scenarioConfig, warmupSecs, measureSecs };
    const child = spawn(process.execPath, [join(__dirname, 'harness', 'statekeep-run.js')], {
      env: { ...BASE_ENV, SK_BENCH_CONFIG: JSON.stringify(cfg) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });

    child.on('close', code => {
      if (code !== 0) {
        const msg = err.trim().split('\n').slice(-3).join(' ');
        resolve({ error: `exit ${code}: ${msg}`, evPerSec: 0 });
        return;
      }
      const m = out.match(/__SK_RESULT__(.+?)__SK_END__/s);
      if (!m) {
        resolve({ error: 'no result marker', evPerSec: 0 });
        return;
      }
      try { resolve(JSON.parse(m[1])); }
      catch { resolve({ error: 'JSON parse error', evPerSec: 0 }); }
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function runLabel(step, total, desc) {
  process.stdout.write(`  [${step}/${total}] ${desc} ... `);
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(72)}`);
console.log('  StateKeep Matrix Benchmark');
console.log('═'.repeat(72));
console.log(`  Axes    : ${selectedAxes.join(', ')}`);
console.log(`  Machines: ${selectedMachines.join(', ')}`);
console.log(`  Warmup  : ${warmupSecs}s · Measure: ${measureSecs}s`);
console.log(`  Note    : run on Linux/WSL — better-sqlite3 requires Linux`);

// Pre-count total steps for progress reporting
let totalSteps = 0;
for (const axisName of selectedAxes) {
  const axis = AXES[axisName];
  if (axisName === 'machine') {
    totalSteps += selectedMachines.length * 3;                            // xstate + apv + sk
  } else if (axisName === 'concurrency') {
    totalSteps += axis.values.length * selectedMachines.length * 3;       // xstate + apv + sk × concurrency values
  } else {
    totalSteps += selectedMachines.length * 2;                            // xstate + apv ceiling
    totalSteps += axis.values.length * selectedMachines.length;           // sk per axis value × machine
  }
}

let step       = 1;
const allResults = [];

for (const axisName of selectedAxes) {
  const axis = AXES[axisName];

  printAxisHeader({
    axisLabel:  axis.label,
    axisName,
    baseline:   BASELINE,
    warmupSecs,
    measureSecs,
  });

  if (axisName === 'machine') {
    // Compare simple vs complex at baseline concurrency
    for (const name of selectedMachines) {
      const m = MACHINES[name];

      runLabel(step++, totalSteps, `XState ${name}`);
      const r1 = await runXState(m.def, m.HAPPY_CYCLE, { concurrency: 1, warmupSecs, measureSecs });
      r1.label = `Pure XState, ${name}`;
      console.log('done');
      printRow(r1, null);
      allResults.push(r1);

      runLabel(step++, totalSteps, `XState+APV ${name}`);
      const r2 = await runXStateApv(m.def, m.HAPPY_CYCLE, m.REGIONS, { concurrency: 1, warmupSecs, measureSecs });
      r2.label = `XState + APV-64, ${name}`;
      console.log('done');
      printRow(r2, r1.evPerSec);
      allResults.push(r2);

      runLabel(step++, totalSteps, `StateKeep ${name}`);
      const r3 = await runStateKeepChild({ machine: name });
      r3.label ??= `StateKeep, ${name} (baseline)`;
      console.log('done');
      printRow(r3, r1.evPerSec);
      allResults.push(r3);
    }

  } else if (axisName === 'concurrency') {
    // For concurrency axis, run XState + SK for each concurrency level
    for (const concurrency of axis.values) {
      for (const name of selectedMachines) {
        const m = MACHINES[name];

        runLabel(step++, totalSteps, `XState ${name} ×${concurrency}`);
        const r1 = await runXState(m.def, m.HAPPY_CYCLE, { concurrency, warmupSecs, measureSecs });
        r1.label = `Pure XState, ${name} ×${concurrency}`;
        console.log('done');
        printRow(r1, null);
        allResults.push(r1);

        runLabel(step++, totalSteps, `XState+APV ${name} ×${concurrency}`);
        const r2 = await runXStateApv(m.def, m.HAPPY_CYCLE, m.REGIONS, { concurrency, warmupSecs, measureSecs });
        r2.label = `XState + APV-64, ${name} ×${concurrency}`;
        console.log('done');
        printRow(r2, r1.evPerSec);
        allResults.push(r2);

        runLabel(step++, totalSteps, `StateKeep ${name} ×${concurrency}`);
        const r3 = await runStateKeepChild({ machine: name, concurrency });
        r3.label ??= `StateKeep, ${name} ×${concurrency}`;
        console.log('done');
        printRow(r3, r1.evPerSec);
        allResults.push(r3);
      }
    }

  } else {
    // All other axes: XState once per machine (at baseline concurrency),
    // then SK for each axis value × machine combination.

    // XState ceilings (shared reference for this axis)
    const xstateCeilings = {};
    for (const name of selectedMachines) {
      const m = MACHINES[name];
      runLabel(step++, totalSteps, `XState ${name} (ceiling)`);
      const r1 = await runXState(m.def, m.HAPPY_CYCLE, { concurrency: 1, warmupSecs, measureSecs });
      r1.label = `Pure XState, ${name}`;
      console.log('done');
      printRow(r1, null);
      allResults.push(r1);
      xstateCeilings[name] = r1.evPerSec;

      runLabel(step++, totalSteps, `XState+APV ${name} (ceiling)`);
      const r2 = await runXStateApv(m.def, m.HAPPY_CYCLE, m.REGIONS, { concurrency: 1, warmupSecs, measureSecs });
      r2.label = `XState + APV-64, ${name}`;
      console.log('done');
      printRow(r2, xstateCeilings[name]);
      allResults.push(r2);
    }

    // SK sweep
    for (const value of axis.values) {
      for (const name of selectedMachines) {
        runLabel(step++, totalSteps, `StateKeep ${name}, ${axisName}=${value}`);
        const r = await runStateKeepChild({ machine: name, [axisName]: value });
        r.label ??= `StateKeep, ${name}, ${axisName}=${value}`;
        console.log('done');
        printRow(r, xstateCeilings[name]);
        allResults.push(r);
      }
    }
  }
}

printSummaryTable(allResults);

const reportFile = saveJsonReport(allResults, {
  baseline: BASELINE,
  timing: { warmupSecs, measureSecs },
  axes: selectedAxes,
  machines: selectedMachines,
});
console.log(`\n  Report saved: ${reportFile}`);
