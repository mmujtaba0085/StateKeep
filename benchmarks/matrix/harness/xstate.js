/**
 * Harness: Pure XState — in-process, no persistence.
 * Establishes the throughput ceiling for a given machine and concurrency level.
 */

import { createMachine, createActor } from '../../../node_modules/xstate/dist/xstate.cjs.mjs';

/**
 * @param {object} machineDef  XState machine definition object
 * @param {string[]} cycle     Ordered event types for one repeating cycle
 * @param {object} opts
 * @param {number} opts.concurrency  Number of parallel actors
 * @param {number} opts.warmupSecs
 * @param {number} opts.measureSecs
 */
export async function run(machineDef, cycle, {
  concurrency  = 1,
  warmupSecs   = 2,
  measureSecs  = 10,
} = {}) {
  const machine = createMachine(machineDef);
  const actors  = Array.from({ length: concurrency }, () => {
    const a = createActor(machine);
    a.start();
    return a;
  });
  const events = cycle.map(type => ({ type }));

  // Warmup — JIT settle
  const warmupEnd = performance.now() + warmupSecs * 1000;
  while (performance.now() < warmupEnd) {
    for (const a of actors) {
      for (const ev of events) a.send(ev);
    }
  }

  // Measure
  const latencies  = [];
  const measureEnd = performance.now() + measureSecs * 1000;
  const t0         = performance.now();

  while (performance.now() < measureEnd) {
    for (const ev of events) {
      for (const a of actors) {
        const s = performance.now();
        a.send(ev);
        latencies.push(performance.now() - s);
      }
    }
  }
  const elapsed = performance.now() - t0;

  actors.forEach(a => a.stop());

  return buildResult('Pure XState', 'in-process, no persistence', elapsed, latencies);
}

function buildResult(label, note, elapsedMs, latencies) {
  const arr   = new Float64Array(latencies).sort();
  const total = arr.length;
  return {
    tier: 'xstate',
    label, note,
    evPerSec:    Math.round(total / (elapsedMs / 1000)),
    p50µs:       arr[Math.floor(total * 0.50)] * 1000,
    p95µs:       arr[Math.floor(total * 0.95)] * 1000,
    p99µs:       arr[Math.floor(total * 0.99)] * 1000,
    totalEvents: total,
    elapsedMs,
  };
}
