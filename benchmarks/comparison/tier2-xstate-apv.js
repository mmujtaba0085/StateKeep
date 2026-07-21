/**
 * Tier 2: XState + APV Fingerprinting — in-process.
 *
 * Same machine as Tier 1, but after each event we chain the APV fingerprint:
 * FNV-1a(prevHash, eventType). This is exactly what StateKeep does per event
 * in the actor worker to track each actor's path through the state graph.
 *
 * Uses Math.imul FNV-32 — matching src/ffi/fallback.js after the BigInt removal.
 *
 * Time-based: runs for measureSecs seconds.
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

export async function run({ warmupSecs = 2, measureSecs = 10 } = {}) {
  const machine = createMachine(MACHINE_DEF);
  const actor   = createActor(machine);
  actor.start();

  let hash = FNV32_OFFSET;
  const warmupEnd = performance.now() + warmupSecs * 1000;
  while (performance.now() < warmupEnd) {
    for (const ev of CYCLE) {
      actor.send(ev);
      hash = fnv1aUpdate(hash, ev.type);
    }
  }

  const latencies = [];
  hash = FNV32_OFFSET;
  const measureEnd = performance.now() + measureSecs * 1000;
  const t0 = performance.now();

  while (performance.now() < measureEnd) {
    for (const ev of CYCLE) {
      const s = performance.now();
      actor.send(ev);
      hash = fnv1aUpdate(hash, ev.type);
      latencies.push(performance.now() - s);
    }
  }
  const elapsed = performance.now() - t0;

  actor.stop();
  if (hash === 0) console.error('hash should never be zero');

  return buildResult('XState + APV', 'in-process, Math.imul FNV-32 per event', elapsed, latencies);
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
