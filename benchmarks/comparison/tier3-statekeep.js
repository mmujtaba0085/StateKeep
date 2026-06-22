/**
 * Tier 3: StateKeep (embedded) — in-process, SQLite + APV + worker pool.
 *
 * Uses createStateKeep() directly — no HTTP server, no API key.
 * Full stack: APV fingerprinting, SQLite write buffer, worker pool, encryption.
 */

import { createStateKeep } from '../../src/lib/index.js';
import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MACHINE_DEF = {
  id: 'order',
  initial: 'idle',
  states: {
    idle:       { on: { PROCESS:  'processing' } },
    processing: { on: { COMPLETE: 'done'       } },
    done:       { on: { RESET:    'idle'        } },
  },
};

const CYCLE = ['PROCESS', 'COMPLETE', 'RESET'];

let _sk          = null;
let _definitionId = null;
let _tmpDir      = null;

async function getOrInit() {
  if (_sk) return { sk: _sk, definitionId: _definitionId };

  _tmpDir = mkdtempSync(join(tmpdir(), 'sk-bench-'));
  const dbPath        = join(_tmpDir, 'bench.db');
  const encryptionKey = randomBytes(32).toString('hex');

  _sk = await createStateKeep({ dbPath, encryptionKey });
  const { id } = await _sk.deployDefinition(MACHINE_DEF);
  _definitionId = id;
  return { sk: _sk, definitionId: _definitionId };
}

export async function cleanup() {
  if (_sk)     { try { await _sk.close(); } catch {} _sk = null; }
  if (_tmpDir) { try { rmSync(_tmpDir, { recursive: true }); } catch {} _tmpDir = null; }
}

export async function run({ warmupCycles = 10, measureCycles = 200 } = {}) {
  const { sk, definitionId } = await getOrInit();

  const actor   = await sk.spawnActor({ definitionId });
  const actorId = actor.id;

  for (let i = 0; i < warmupCycles; i++) {
    for (const type of CYCLE) await sk.sendEvent(actorId, { type });
  }

  const latencies = new Float64Array(measureCycles * CYCLE.length);
  let idx = 0;

  const t0 = performance.now();
  for (let i = 0; i < measureCycles; i++) {
    for (const type of CYCLE) {
      const s = performance.now();
      await sk.sendEvent(actorId, { type });
      latencies[idx++] = performance.now() - s;
    }
  }
  const elapsed = performance.now() - t0;

  return buildResult('StateKeep (embedded)', 'in-process SQLite+workers+APV, no HTTP', elapsed, latencies);
}

export async function runConcurrent({ concurrency = 10, eventsPerActor = 30 } = {}) {
  const { sk, definitionId } = await getOrInit();

  const actors = await Promise.all(
    Array.from({ length: concurrency }, () => sk.spawnActor({ definitionId }))
  );

  await Promise.all(actors.map(async a => {
    for (const type of CYCLE) await sk.sendEvent(a.id, { type });
  }));

  const totalEvents = concurrency * eventsPerActor;
  const t0          = performance.now();

  await Promise.all(actors.map(async a => {
    const cycles = Math.floor(eventsPerActor / CYCLE.length);
    for (let i = 0; i < cycles; i++) {
      for (const type of CYCLE) await sk.sendEvent(a.id, { type });
    }
  }));

  const elapsed  = performance.now() - t0;
  const evPerSec = Math.round(totalEvents / (elapsed / 1000));
  return {
    label:      `StateKeep embedded (${concurrency} concurrent actors)`,
    evPerSec,
    elapsedMs:  elapsed,
    totalEvents,
  };
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
