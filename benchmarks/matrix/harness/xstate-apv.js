/**
 * Harness: XState + APV-64 fingerprinting — in-process, no persistence.
 *
 * Adds 64-bit FNV-1a fingerprint chaining after each event, matching
 * exactly what StateKeep's actorWorker does: one updateFingerprint() call
 * per region that actually changed state in this transition.
 *
 * For simple machines (no parallel regions): 1 fingerprint update per event.
 * For complex machines (N parallel regions):  updates only the regions whose
 * XState snapshot leaf value changed — typically 1 per event on the happy path.
 */

import { createMachine, createActor } from '../../../node_modules/xstate/dist/xstate.cjs.mjs';
import { updateFingerprint } from '../../../src/ffi/fingerprintChain.js';

// Returns a flat map of all leaf state paths → active state name,
// e.g. { 'processing.transcode.video': 'encoding', ... }
function leafStates(snapshot) {
  const result = {};
  function walk(value, path) {
    if (typeof value === 'string') {
      result[path] = value;
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  }
  walk(snapshot.value, '');
  return result;
}

/**
 * @param {object}   machineDef
 * @param {string[]} cycle
 * @param {string[]} regions      Parallel region paths from the machine module (may be empty)
 * @param {object}   opts
 */
export async function run(machineDef, cycle, regions, {
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
  // Per-actor fingerprint map: actorIndex → { regionPath: hexString }
  const fps = actors.map(() => ({}));
  const events = cycle.map(type => ({ type }));

  const isParallel = regions.length > 0;

  function sendWithFingerprint(actor, fp, ev) {
    if (isParallel) {
      const before = leafStates(actor.getSnapshot());
      actor.send(ev);
      const after = leafStates(actor.getSnapshot());
      for (const [path, state] of Object.entries(after)) {
        if (before[path] !== state) {
          fp[path] = updateFingerprint(fp[path] ?? null, ev.type);
        }
      }
    } else {
      actor.send(ev);
      fp['_'] = updateFingerprint(fp['_'] ?? null, ev.type);
    }
  }

  // Warmup
  const warmupEnd = performance.now() + warmupSecs * 1000;
  while (performance.now() < warmupEnd) {
    for (let i = 0; i < actors.length; i++) {
      for (const ev of events) sendWithFingerprint(actors[i], fps[i], ev);
    }
  }
  // Reset fingerprints after warmup
  fps.forEach(fp => { for (const k of Object.keys(fp)) fp[k] = null; });

  // Measure
  const latencies  = [];
  const measureEnd = performance.now() + measureSecs * 1000;
  const t0         = performance.now();

  while (performance.now() < measureEnd) {
    for (const ev of events) {
      for (let i = 0; i < actors.length; i++) {
        const s = performance.now();
        sendWithFingerprint(actors[i], fps[i], ev);
        latencies.push(performance.now() - s);
      }
    }
  }
  const elapsed = performance.now() - t0;

  actors.forEach(a => a.stop());
  // Prevent dead-code elimination of fingerprint result
  if (Object.values(fps[0]).some(v => v === null)) console.error('fp bug');

  return buildResult('XState + APV-64', 'in-process, FNV-64 per changed region', elapsed, latencies);
}

function buildResult(label, note, elapsedMs, latencies) {
  const arr   = new Float64Array(latencies).sort();
  const total = arr.length;
  return {
    tier: 'xstate-apv',
    label, note,
    evPerSec:    Math.round(total / (elapsedMs / 1000)),
    p50µs:       arr[Math.floor(total * 0.50)] * 1000,
    p95µs:       arr[Math.floor(total * 0.95)] * 1000,
    p99µs:       arr[Math.floor(total * 0.99)] * 1000,
    totalEvents: total,
    elapsedMs,
  };
}
