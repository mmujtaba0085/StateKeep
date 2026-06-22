/**
 * Tier 2: XState + APV Fingerprinting — in-process.
 *
 * Same machine as Tier 1, but after each event we chain the APV fingerprint:
 * FNV-1a(prevHash, eventType). This is exactly what StateKeep does per event
 * in the actor worker to track each actor's path through the state graph.
 *
 * Uses Math.imul FNV-32 — matching src/ffi/fallback.js after the BigInt removal.
 */

import { createMachine, createActor } from '../../node_modules/xstate/dist/xstate.cjs.mjs';

const FNV32_OFFSET = 0x811c9dc5;
const FNV32_PRIME  = 0x01000193;

function fnv1aUpdate(hash, str) {
  const buf = Buffer.from(str, 'utf8');
  let h = hash;
  for (let i = 0; i < buf.length; i++) {
    h = Math.imul(h ^ buf[i], FNV32_PRIME) >>> 0;
  }
  return h;
}

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

  let hash = FNV32_OFFSET;
  for (let i = 0; i < warmupCycles; i++) {
    for (const ev of CYCLE) {
      actor.send(ev);
      hash = fnv1aUpdate(hash, ev.type);
    }
  }

  const latencies = new Float64Array(measureCycles * CYCLE.length);
  let idx = 0;
  hash = FNV32_OFFSET;

  const t0 = performance.now();
  for (let i = 0; i < measureCycles; i++) {
    for (const ev of CYCLE) {
      const s = performance.now();
      actor.send(ev);
      hash = fnv1aUpdate(hash, ev.type);
      latencies[idx++] = performance.now() - s;
    }
  }
  const elapsed = performance.now() - t0;

  actor.stop();

  if (hash === 0) console.error('hash should never be zero');

  return buildResult('XState + APV', 'in-process, Math.imul FNV-32 per event', elapsed, latencies);
}

function buildResult(label, note, elapsedMs, latencies) {
  const sorted   = Float64Array.from(latencies).sort();
  const total    = latencies.length;
  const evPerSec = Math.round(total / (elapsedMs / 1000));
  const p50      = sorted[Math.floor(total * 0.50)] * 1000;
  const p95      = sorted[Math.floor(total * 0.95)] * 1000;
  const p99      = sorted[Math.floor(total * 0.99)] * 1000;
  return { label, note, evPerSec, p50, p95, p99, totalEvents: total, elapsedMs };
}
