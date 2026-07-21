/**
 * Tier 3: StateKeep (embedded) — in-process, SQLite + APV + worker pool.
 *
 * Uses createStateKeep() directly — no HTTP server, no API key.
 * Encryption key is explicitly NOT set so context is stored as plaintext.
 *
 * Three durability modes:
 *   buffered (default) — flush every FLUSH_MS, 50ms crash window
 *   sync               — flush immediately per event, zero crash window, slower
 *   async              — skip write buffer, hot-registry only until eviction
 *
 * Time-based: runs for measureSecs seconds so throughput is directly
 * comparable to tier1/tier2 which run the same wall-clock budget.
 */

// Ensure no encryption key leaks in from the environment
delete process.env.STATEKEEP_ENCRYPTION_KEY;

import { createStateKeep } from '../../src/lib/index.js';
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

let _sk           = null;
let _definitionId = null;
let _tmpDir       = null;

async function getOrInit() {
  if (_sk) return { sk: _sk, definitionId: _definitionId };

  _tmpDir = mkdtempSync(join(tmpdir(), 'sk-bench-'));
  const dbPath = join(_tmpDir, 'bench.db');

  _sk = await createStateKeep({ dbPath }); // no encryptionKey — self-hosted
  const { id } = await _sk.deployDefinition(MACHINE_DEF);
  _definitionId = id;
  return { sk: _sk, definitionId: _definitionId };
}

export async function cleanup() {
  if (_sk)     { try { await _sk.close(); } catch {} _sk = null; }
  if (_tmpDir) { try { rmSync(_tmpDir, { recursive: true }); } catch {} _tmpDir = null; }
}

export async function runDurability(durability = 'buffered', { warmupSecs = 2, measureSecs = 10 } = {}) {
  const { sk, definitionId } = await getOrInit();

  const actor   = await sk.spawnActor({ definitionId });
  const actorId = actor.id;

  // Warmup
  const warmupEnd = performance.now() + warmupSecs * 1000;
  while (performance.now() < warmupEnd) {
    for (const type of CYCLE) await sk.sendEvent(actorId, { type }, { durability });
  }

  // Measure
  const latencies = [];
  const measureEnd = performance.now() + measureSecs * 1000;
  const t0 = performance.now();

  while (performance.now() < measureEnd) {
    for (const type of CYCLE) {
      const s = performance.now();
      await sk.sendEvent(actorId, { type }, { durability });
      latencies.push(performance.now() - s);
    }
  }
  const elapsed = performance.now() - t0;

  const label = durability === 'sync'
    ? 'StateKeep SQLite (sync — zero loss)'
    : durability === 'async'
    ? 'StateKeep SQLite (async — hot registry only)'
    : 'StateKeep SQLite (buffered — 50ms window)';

  const note = durability === 'sync'
    ? 'flush to SQLite per event, zero crash window'
    : durability === 'async'
    ? 'no write buffer — persists on actor eviction only'
    : 'in-process SQLite write buffer, 50ms window';

  return buildResult(label, note, elapsed, latencies);
}

// Backward-compat alias
export const run = (opts) => runDurability('buffered', opts);

export async function runConcurrent({ concurrency = 10, measureSecs = 10 } = {}) {
  const { sk, definitionId } = await getOrInit();

  const actors = await Promise.all(
    Array.from({ length: concurrency }, () => sk.spawnActor({ definitionId }))
  );

  // Warmup — one full cycle per actor
  await Promise.all(actors.map(async a => {
    for (const type of CYCLE) await sk.sendEvent(a.id, { type });
  }));

  let totalEvents = 0;
  const t0       = performance.now();
  const endTime  = t0 + measureSecs * 1000;

  await Promise.all(actors.map(async a => {
    while (performance.now() < endTime) {
      for (const type of CYCLE) {
        await sk.sendEvent(a.id, { type });
        totalEvents++;
      }
    }
  }));

  const elapsed = performance.now() - t0;
  return {
    label:      `StateKeep SQLite (${concurrency} concurrent actors)`,
    evPerSec:   Math.round(totalEvents / (elapsed / 1000)),
    elapsedMs:  elapsed,
    totalEvents,
  };
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
