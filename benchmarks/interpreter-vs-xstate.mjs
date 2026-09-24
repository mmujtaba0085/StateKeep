/**
 * benchmarks/interpreter-vs-xstate.mjs
 *
 * Head-to-head: XState runtime vs StateKeep interpreter.
 *
 * Both run the same machine, same event cycle, same wall-clock budget.
 * No SQLite, no HTTP, no worker pool — pure in-process interpreter throughput.
 *
 * StateKeep is now XState-independent (xstate in devDependencies only).
 * This benchmark exists to verify the custom interpreter is competitive.
 *
 * Usage:
 *   node benchmarks/interpreter-vs-xstate.mjs
 *   MEASURE_SECS=30 node benchmarks/interpreter-vs-xstate.mjs
 */

import { createMachine, createActor }           from './node_modules/xstate/dist/xstate.cjs.mjs';
import { compileMachine }                        from '../src/runtime/definitionCompiler.js';
import { computeInitialSnapshot, processEvent }  from '../src/runtime/interpreter.js';

const WARMUP_SECS  = parseInt(process.env.WARMUP_SECS  ?? '3',  10);
const MEASURE_SECS = parseInt(process.env.MEASURE_SECS ?? '10', 10);
const REGISTRY     = { guards: {}, actions: {}, services: {} };

// ── Machines ──────────────────────────────────────────────────────────────────

const SIMPLE = {
  id: 'order',
  initial: 'idle',
  states: {
    idle:       { on: { PROCESS:  'processing' } },
    processing: { on: { COMPLETE: 'done'       } },
    done:       { on: { RESET:    'idle'        } },
  },
};

const COMPLEX = {
  id: 'loan',
  initial: 'draft',
  states: {
    draft:      { on: { SUBMIT: 'review',   SAVE: 'draft'    } },
    review:     { on: { APPROVE: 'approved', REJECT: 'draft', REQUEST_INFO: 'info_needed' } },
    info_needed:{ on: { RESUBMIT: 'review', WITHDRAW: 'draft' } },
    approved:   { on: { DISBURSE: 'active', CANCEL: 'cancelled' } },
    active:     { on: { CLOSE: 'closed',   DEFAULT: 'defaulted' } },
    closed:     { type: 'final' },
    cancelled:  { type: 'final' },
    defaulted:  { type: 'final' },
  },
};
const COMPLEX_CYCLE = ['SUBMIT', 'APPROVE', 'DISBURSE', 'CLOSE'];

// ── Timing helpers ────────────────────────────────────────────────────────────

function measure(secs, fn) {
  const end  = performance.now() + secs * 1000;
  let   count = 0;
  const lats = [];
  while (performance.now() < end) {
    const t = performance.now();
    fn();
    lats.push(performance.now() - t);
    count++;
  }
  lats.sort((a, b) => a - b);
  const us = (pct) => (lats[Math.floor(lats.length * pct / 100)] * 1000).toFixed(1);
  return {
    count,
    evPerSec: Math.round(count / secs),
    p50: us(50), p95: us(95), p99: us(99),
  };
}

function warmup(secs, fn) {
  const end = performance.now() + secs * 1000;
  while (performance.now() < end) fn();
}

function bar(evs, max) {
  const filled = Math.round(evs / max * 30);
  return '█'.repeat(filled) + '░'.repeat(30 - filled);
}

function print(label, note, r, maxEvs) {
  console.log(`\n  ${label}`);
  console.log(`  ${'·'.repeat(68)}`);
  console.log(`  ${note}`);
  console.log(`  ev/s    : ${r.evPerSec.toLocaleString().padStart(9)}   ${bar(r.evPerSec, maxEvs)}`);
  console.log(`  latency : p50=${r.p50}µs  p95=${r.p95}µs  p99=${r.p99}µs`);
  console.log(`  total   : ${r.count.toLocaleString()} events in ${MEASURE_SECS}s`);
}

// ── Header ────────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(70));
console.log('  XState runtime  vs  StateKeep interpreter');
console.log('  In-process · no persistence · no worker pool · same event budget');
console.log('═'.repeat(70));
console.log(`  Warmup : ${WARMUP_SECS}s per tier`);
console.log(`  Measure: ${MEASURE_SECS}s per tier`);
console.log(`  Note   : StateKeep includes FNV-32 fingerprinting (production path)`);
console.log('─'.repeat(70));

// ══════════════════════════════════════════════════════════════════════════════
//  SIMPLE MACHINE  (3 states, 1 transition per event)
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n  ── Simple machine (3 states: idle → processing → done → idle) ──\n');

// XState — simple
process.stdout.write('  [1/4] XState, simple machine ... ');
let xsSimple;
{
  const machine = createMachine(SIMPLE);
  const actor   = createActor(machine);
  actor.start();
  const cycle = [{ type: 'PROCESS' }, { type: 'COMPLETE' }, { type: 'RESET' }];
  warmup(WARMUP_SECS, () => { for (const e of cycle) actor.send(e); });
  xsSimple = measure(MEASURE_SECS, () => { for (const e of cycle) actor.send(e); });
  console.log('done');
}

// StateKeep — simple
process.stdout.write('  [2/4] StateKeep, simple machine ... ');
let skSimple;
{
  const compiled = compileMachine(SIMPLE);
  const snap     = computeInitialSnapshot(compiled, SIMPLE, {}, REGISTRY);
  let   entry    = { stateValue: snap.stateValue, context: snap.context,
                     historyFingerprint: snap.historyFingerprint, stateEntryId: snap.stateEntryId ?? 0 };
  const cycle = ['PROCESS', 'COMPLETE', 'RESET'];
  warmup(WARMUP_SECS, () => {
    for (const type of cycle) {
      const r = processEvent(entry, compiled, { type }, REGISTRY, []);
      entry = { stateValue: r.stateValue, context: r.context,
                historyFingerprint: r.historyFingerprint, stateEntryId: r.stateEntryId };
    }
  });
  skSimple = measure(MEASURE_SECS, () => {
    for (const type of cycle) {
      const r = processEvent(entry, compiled, { type }, REGISTRY, []);
      entry = { stateValue: r.stateValue, context: r.context,
                historyFingerprint: r.historyFingerprint, stateEntryId: r.stateEntryId };
    }
  });
  console.log('done');
}

const maxSimple = Math.max(xsSimple.evPerSec, skSimple.evPerSec);
print('XState      (simple)', 'createMachine + actor.send() — no fingerprinting', xsSimple, maxSimple);
print('StateKeep   (simple)', 'compileMachine + processEvent — includes FNV-32 per event', skSimple, maxSimple);

// ══════════════════════════════════════════════════════════════════════════════
//  COMPLEX MACHINE  (8 states, multiple branches)
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n\n  ── Complex machine (8 states, branching loan flow) ──\n');

// XState — complex
process.stdout.write('  [3/4] XState, complex machine ... ');
let xsComplex;
{
  const machine  = createMachine(COMPLEX);
  const cycle    = COMPLEX_CYCLE.map(type => ({ type }));
  warmup(WARMUP_SECS, () => {
    const a = createActor(machine); a.start();
    for (const e of cycle) a.send(e);
  });
  xsComplex = measure(MEASURE_SECS, () => {
    const a = createActor(machine); a.start();
    for (const e of cycle) a.send(e);
  });
  console.log('done');
}

// StateKeep — complex
process.stdout.write('  [4/4] StateKeep, complex machine ... ');
let skComplex;
{
  const compiled = compileMachine(COMPLEX);
  warmup(WARMUP_SECS, () => {
    const snap = computeInitialSnapshot(compiled, COMPLEX, {}, REGISTRY);
    let entry  = { stateValue: snap.stateValue, context: snap.context,
                   historyFingerprint: snap.historyFingerprint, stateEntryId: snap.stateEntryId ?? 0 };
    for (const type of COMPLEX_CYCLE) {
      const r = processEvent(entry, compiled, { type }, REGISTRY, []);
      entry = { stateValue: r.stateValue, context: r.context,
                historyFingerprint: r.historyFingerprint, stateEntryId: r.stateEntryId };
    }
  });
  skComplex = measure(MEASURE_SECS, () => {
    const snap = computeInitialSnapshot(compiled, COMPLEX, {}, REGISTRY);
    let entry  = { stateValue: snap.stateValue, context: snap.context,
                   historyFingerprint: snap.historyFingerprint, stateEntryId: snap.stateEntryId ?? 0 };
    for (const type of COMPLEX_CYCLE) {
      const r = processEvent(entry, compiled, { type }, REGISTRY, []);
      entry = { stateValue: r.stateValue, context: r.context,
                historyFingerprint: r.historyFingerprint, stateEntryId: r.stateEntryId };
    }
  });
  console.log('done');
}

const maxComplex = Math.max(xsComplex.evPerSec, skComplex.evPerSec);
print('XState      (complex)', 'createMachine + createActor + actor.send() per cycle', xsComplex, maxComplex);
print('StateKeep   (complex)', 'compileMachine + processEvent per cycle', skComplex, maxComplex);

// ══════════════════════════════════════════════════════════════════════════════
//  SUMMARY
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n\n' + '═'.repeat(70));
console.log('  SUMMARY');
console.log('═'.repeat(70));

const rows = [
  ['XState      simple',    xsSimple.evPerSec],
  ['StateKeep   simple',    skSimple.evPerSec],
  ['XState      complex',   xsComplex.evPerSec],
  ['StateKeep   complex',   skComplex.evPerSec],
];
const maxAll = Math.max(...rows.map(r => r[1]));
for (const [label, evs] of rows) {
  console.log(`  ${label.padEnd(22)} ${String(evs.toLocaleString()).padStart(9)} ev/s  ${bar(evs, maxAll)}`);
}

const simpleRatio  = (skSimple.evPerSec  / xsSimple.evPerSec).toFixed(2);
const complexRatio = (skComplex.evPerSec / xsComplex.evPerSec).toFixed(2);
console.log('');
console.log(`  StateKeep vs XState  —  simple: ${simpleRatio}×  complex: ${complexRatio}×`);
console.log(`  (>1.0 = StateKeep faster; includes FNV-32 fingerprinting overhead)`);
console.log('═'.repeat(70) + '\n');
