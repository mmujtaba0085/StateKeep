/**
 * Tier 1: Pure XState — in-process, no persistence, no APV.
 *
 * Measures raw state machine throughput: how fast XState can process events
 * in memory with no other overhead.
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

export async function run({ warmupCycles = 5_000, measureCycles = 100_000 } = {}) {
  const machine = createMachine(MACHINE_DEF);
  const actor   = createActor(machine);
  actor.start();

  // Warm up — let JIT compile the hot path
  for (let i = 0; i < warmupCycles; i++) {
    for (const ev of CYCLE) actor.send(ev);
  }

  const latencies = new Float64Array(measureCycles * CYCLE.length);
  let idx = 0;

  const t0 = performance.now();
  for (let i = 0; i < measureCycles; i++) {
    for (const ev of CYCLE) {
      const s = performance.now();
      actor.send(ev);
      latencies[idx++] = performance.now() - s;
    }
  }
  const elapsed = performance.now() - t0;

  actor.stop();

  return buildResult('Pure XState', 'in-process, no persistence', elapsed, latencies);
}

function buildResult(label, note, elapsedMs, latencies) {
  const sorted   = Float64Array.from(latencies).sort();
  const total    = latencies.length;
  const evPerSec = Math.round(total / (elapsedMs / 1000));
  const p50      = sorted[Math.floor(total * 0.50)] * 1000; // µs
  const p95      = sorted[Math.floor(total * 0.95)] * 1000;
  const p99      = sorted[Math.floor(total * 0.99)] * 1000;
  return { label, note, evPerSec, p50, p95, p99, totalEvents: total, elapsedMs };
}
