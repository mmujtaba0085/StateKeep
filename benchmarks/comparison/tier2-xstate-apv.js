/**
 * Tier 2: XState + APV Fingerprinting — in-process.
 *
 * Same machine as Tier 1, but after each event we chain the APV fingerprint:
 * FNV-1a(prevHash, eventType). This is exactly what StateKeep does per event
 * in the actor worker to track each actor's path through the state graph.
 *
 * Isolates the CPU cost of APV path tracking from the HTTP/DB overhead of
 * the full StateKeep stack.
 */

import { createMachine, createActor } from '../../node_modules/xstate/dist/xstate.cjs.mjs';

// FNV-1a 64-bit — same algorithm as src/ffi/fallback.js and the C engine
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME  = 0x00000100000001b3n;
const UINT64_MAX = 0xffffffffffffffffn;

function fnv1aUpdate(hash, str) {
  const buf = Buffer.from(str, 'utf8');
  for (const byte of buf) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & UINT64_MAX;
  }
  return hash;
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

  // Warm up
  let hash = FNV_OFFSET;
  for (let i = 0; i < warmupCycles; i++) {
    for (const ev of CYCLE) {
      actor.send(ev);
      hash = fnv1aUpdate(hash, ev.type);
    }
  }

  const latencies = new Float64Array(measureCycles * CYCLE.length);
  let idx = 0;
  hash = FNV_OFFSET; // reset hash for measurement

  const t0 = performance.now();
  for (let i = 0; i < measureCycles; i++) {
    for (const ev of CYCLE) {
      const s = performance.now();
      actor.send(ev);
      hash = fnv1aUpdate(hash, ev.type); // APV fingerprint chain
      latencies[idx++] = performance.now() - s;
    }
  }
  const elapsed = performance.now() - t0;

  actor.stop();

  // Prevent dead-code elimination of hash computation
  if (hash === 0n) console.error('hash should never be zero');

  return buildResult('XState + APV', 'in-process, APV fingerprint per event', elapsed, latencies);
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
