/**
 * StateKeep embedded benchmark — runs in a child process.
 *
 * Configuration arrives via SK_BENCH_CONFIG (JSON-encoded env var).
 * Result is written to stdout as __SK_RESULT__<json>__SK_END__.
 *
 * Each run is a clean process so module singletons never cross between scenarios.
 */

import { mkdtempSync, rmSync } from 'fs';
import { join }                from 'path';
import { tmpdir }              from 'os';
import { fileURLToPath }       from 'url';
import { dirname }             from 'path';
import { createStateKeep }     from '../../../src/lib/index.js';
import { CONTEXT_PAYLOADS }    from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const config = JSON.parse(process.env.SK_BENCH_CONFIG ?? '{}');
const {
  machine:     machineName  = 'simple',
  durability                = 'buffered',
  encryption                = 'off',
  concurrency               = 1,
  context:     contextSize  = 'none',
  migration                 = 'idle',
  warmupSecs                = 2,
  measureSecs               = 10,
} = config;

// --- Machine definitions ---------------------------------------------------

const { def: machineDefV1, HAPPY_CYCLE: cycle } = await import(`../machines/${machineName}.js`);

// V2 definition for the migration axis — computed lazily only when needed.
// Must match the active machineName (machineDefV1 is whatever was imported above).
function makeV2Def() {
  if (machineName === 'simple') {
    return {
      ...machineDefV1,
      states: {
        ...machineDefV1.states,
        escalated: { on: { RESOLVE: 'done' } },
      },
    };
  }
  // complex — add an extra event to the metadata waiting state
  const d = JSON.parse(JSON.stringify(machineDefV1));
  d.states.processing.states.metadata.states.waiting.on.SUBTITLE_START = 'extracting';
  return d;
}

// --- Setup -----------------------------------------------------------------

delete process.env.STATEKEEP_ENCRYPTION_KEY;
const encryptionKey = encryption === 'on'
  ? 'ab'.repeat(32) // 64-char hex test key
  : undefined;

const tmpDir = mkdtempSync(join(tmpdir(), 'sk-matrix-'));
const dbPath = join(tmpDir, 'bench.db');

async function main() {
  const sk = await createStateKeep({ dbPath, encryptionKey });

  const { id: defId } = await sk.deployDefinition(machineDefV1);

  // For migration axis: pre-populate the APV engine with dummy changepoints
  // then deploy V2 so actors will migrate on first event post-measurement-start.
  if (migration === 'active') {
    const { engineReady, getEngine } = await import('../../../src/ffi/engine.js');
    await engineReady;
    const eng = getEngine();
    // 200 stale changepoints — exercises computeAccessible scan cost
    for (let i = 0; i < 200; i++) {
      const t = eng.clockTick();
      eng.registerChangepoint(t, BigInt(i * 997 + 1), BigInt(i + 1), `bench-stale-${i}`);
    }
  }

  // Spawn actors with optional initial context
  const initialContext = CONTEXT_PAYLOADS[contextSize];
  const actors = await Promise.all(
    Array.from({ length: concurrency }, () =>
      sk.spawnActor({ definitionId: defId, context: initialContext })
    )
  );
  const ids = actors.map(a => a.id);

  // --- Warmup ----------------------------------------------------------------
  const warmupEnd = performance.now() + warmupSecs * 1000;
  while (performance.now() < warmupEnd) {
    for (const type of cycle) {
      for (const id of ids) {
        await sk.sendEvent(id, { type }, { durability });
      }
    }
  }

  // For migration axis: deploy V2 now, so the first measured event per actor
  // triggers a migration check and potentially a hydration pass.
  if (migration === 'active') {
    await sk.deployDefinition(makeV2Def());
  }

  // --- Measure ---------------------------------------------------------------
  const latencies  = [];
  const measureEnd = performance.now() + measureSecs * 1000;
  const t0         = performance.now();

  while (performance.now() < measureEnd) {
    for (const type of cycle) {
      for (const id of ids) {
        const s = performance.now();
        await sk.sendEvent(id, { type }, { durability });
        latencies.push(performance.now() - s);
      }
    }
  }
  const elapsed = performance.now() - t0;

  await sk.close();

  // Build result
  const arr   = new Float64Array(latencies).sort();
  const total = arr.length;

  const result = {
    tier: 'statekeep',
    label: buildLabel(machineName, durability, encryption, concurrency, contextSize, migration),
    note:  buildNote(durability, encryption, concurrency, contextSize, migration),
    evPerSec:    Math.round(total / (elapsed / 1000)),
    p50µs:       arr[Math.floor(total * 0.50)] * 1000,
    p95µs:       arr[Math.floor(total * 0.95)] * 1000,
    p99µs:       arr[Math.floor(total * 0.99)] * 1000,
    totalEvents: total,
    elapsedMs:   elapsed,
    config,
  };

  process.stdout.write(`__SK_RESULT__${JSON.stringify(result)}__SK_END__\n`);
}

function buildLabel(machine, dur, enc, conc, ctx, mig) {
  const parts = [`StateKeep ${machine}`];
  if (dur !== 'buffered') parts.push(dur);
  if (enc === 'on')       parts.push('encrypted');
  if (conc > 1)           parts.push(`${conc} actors`);
  if (ctx !== 'none')     parts.push(`ctx:${ctx}`);
  if (mig === 'active')   parts.push('migration:active');
  return parts.join(', ');
}

function buildNote(dur, enc, conc, ctx, mig) {
  const parts = [];
  if (dur === 'sync')   parts.push('flush per event');
  if (dur === 'async')  parts.push('hot-registry only');
  if (dur === 'buffered') parts.push('50ms write window');
  if (enc === 'on')     parts.push('AES-256-GCM context');
  if (mig === 'active') parts.push('APV registry: 200 changepoints + V2 mid-bench');
  return parts.join(', ');
}

main().catch(err => {
  console.error('[statekeep-run] Fatal:', err.message);
  process.exitCode = 1;
}).finally(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
