/**
 * Tier 1: Pure XState — in-process, no persistence, no APV.
 *
 * Time-based: runs for MEASURE_SECS seconds so all tiers share the same
 * wall-clock budget and throughput numbers are directly comparable.
 */

import { createMachine, createActor } from '../../node_modules/xstate/dist/xstate.cjs.mjs';

const MACHINE_DEF = {
  id: 'order',
  initial: 'idle',
  states: {
    idle:       { on: { PROCESS:  'processing' } },
    processing: { on: { COMPLETE: 'done'       } },
    done:       { on: { RESET:    'idle'        } },
  },
};

const CYCLE = [{ type: 'PROCESS' }, { type: 'COMPLETE' }, { type: 'RESET' }];

export async function run({ warmupSecs = 2, measureSecs = 10 } = {}) {
  const machine = createMachine(MACHINE_DEF);
  const actor   = createActor(machine);
  actor.start();

  // Warmup — let JIT compile the hot path
  const warmupEnd = performance.now() + warmupSecs * 1000;
  while (performance.now() < warmupEnd) {
    for (const ev of CYCLE) actor.send(ev);
  }

  // Measure
  const latencies = [];
  const measureEnd = performance.now() + measureSecs * 1000;
  const t0 = performance.now();

  while (performance.now() < measureEnd) {
    for (const ev of CYCLE) {
      const s = performance.now();
      actor.send(ev);
      latencies.push(performance.now() - s);
    }
  }
  const elapsed = performance.now() - t0;

  actor.stop();

  return buildResult('Pure XState', 'in-process, no persistence', elapsed, latencies);
}

function buildResult(label, note, elapsedMs, latencies) {
  const arr    = new Float64Array(latencies).sort();
  const total  = arr.length;
  return {
    label, note,
    evPerSec:    Math.round(total / (elapsedMs / 1000)),
    p50:         arr[Math.floor(total * 0.50)] * 1000,
    p95:         arr[Math.floor(total * 0.95)] * 1000,
    p99:         arr[Math.floor(total * 0.99)] * 1000,
    totalEvents: total,
    elapsedMs,
  };
}
