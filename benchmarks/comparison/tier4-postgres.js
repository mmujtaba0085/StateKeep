/**
 * benchmarks/comparison/tier4-postgres.js
 *
 * StateKeep (embedded) with Postgres backend — same machine, time-based measurement.
 * Must run in its own process because isPostgres is a module-level singleton.
 *
 * Encryption key is explicitly NOT set — context stored as plaintext.
 *
 * Connection: Unix socket peer auth — no password needed.
 * URL: postgresql:///statekeep_bench?host=/var/run/postgresql
 *
 * When run directly: outputs __PG_RESULTS__[...]__PG_END__ to stdout.
 * Spawned by run.js which parses that JSON and merges into the summary.
 */

const DB_URL = process.env.STATEKEEP_PG_URL
  ?? 'postgresql:///statekeep_bench?host=/var/run/postgresql';

// Must set before any import resolves singletons
process.env.STATEKEEP_DB_URL = DB_URL;

// Ensure no encryption key leaks in from the environment
delete process.env.STATEKEEP_ENCRYPTION_KEY;

import { createStateKeep } from '../../src/lib/index.js';

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

async function run({
  warmupSecs  = parseInt(process.env.WARMUP_SECS  ?? '2',  10),
  measureSecs = parseInt(process.env.MEASURE_SECS ?? '10', 10),
} = {}) {
  const sk = await createStateKeep({ dbUrl: DB_URL });
  const { id: definitionId } = await sk.deployDefinition(MACHINE_DEF);

  const results = [];

  for (const durability of ['buffered', 'sync', 'async']) {
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

    const arr   = new Float64Array(latencies).sort();
    const total = arr.length;

    results.push({
      label:       `StateKeep Postgres (${durability})`,
      note:        durability === 'sync'
        ? 'Postgres transaction per event, zero crash window'
        : durability === 'async'
        ? 'Postgres — hot registry only, no flush'
        : 'Postgres write buffer, 50ms window',
      evPerSec:    Math.round(total / (elapsed / 1000)),
      p50:         arr[Math.floor(total * 0.50)] * 1000,
      p95:         arr[Math.floor(total * 0.95)] * 1000,
      p99:         arr[Math.floor(total * 0.99)] * 1000,
      totalEvents: total,
      elapsedMs:   elapsed,
    });
  }

  // Concurrent benchmark
  const CONCURRENCY = 10;
  const actors = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => sk.spawnActor({ definitionId }))
  );
  await Promise.all(actors.map(async a => {
    for (const type of CYCLE) await sk.sendEvent(a.id, { type });
  }));

  let totalEvents = 0;
  const t0c    = performance.now();
  const endC   = t0c + measureSecs * 1000;

  await Promise.all(actors.map(async a => {
    while (performance.now() < endC) {
      for (const type of CYCLE) {
        await sk.sendEvent(a.id, { type });
        totalEvents++;
      }
    }
  }));

  const elapsedC = performance.now() - t0c;
  results.push({
    label:      `StateKeep Postgres (${CONCURRENCY} concurrent actors)`,
    note:       'Postgres MVCC — parallel writes without single-writer lock',
    evPerSec:   Math.round(totalEvents / (elapsedC / 1000)),
    totalEvents,
    elapsedMs:  elapsedC,
    concurrent: true,
  });

  await sk.close();

  process.stdout.write('\n__PG_RESULTS__' + JSON.stringify(results) + '__PG_END__\n');
  process.exit(0);
}

run().catch(err => {
  process.stderr.write('[tier4-postgres] Fatal: ' + err.message + '\n' + err.stack + '\n');
  process.exit(1);
});
