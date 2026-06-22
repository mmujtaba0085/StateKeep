/**
 * benchmarks/comparison/tier4-postgres.js
 *
 * StateKeep (embedded) with Postgres backend — same machine, same cycle as
 * tier3-statekeep.js. Must run in its own process because isPostgres is a
 * module-level singleton that can't be changed after the first import.
 *
 * When run directly: outputs a JSON array of result objects to stdout.
 * Spawned by run.js which parses that JSON and merges into the summary.
 *
 * Connection: Unix socket peer auth — no password needed.
 * URL: postgresql:///statekeep_bench?host=/var/run/postgresql
 */

const DB_URL = process.env.STATEKEEP_PG_URL
  ?? 'postgresql:///statekeep_bench?host=/var/run/postgresql';

// Must set before any import resolves singletons
process.env.STATEKEEP_DB_URL = DB_URL;

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

async function run() {
  const sk = await createStateKeep({ dbUrl: DB_URL });
  const { id: definitionId } = await sk.deployDefinition(MACHINE_DEF);

  const results = [];

  for (const durability of ['buffered', 'sync', 'async']) {
    const actor   = await sk.spawnActor({ definitionId });
    const actorId = actor.id;

    // Warmup
    for (let i = 0; i < 10; i++) {
      for (const type of CYCLE) await sk.sendEvent(actorId, { type }, { durability });
    }

    const MEASURE = 200;
    const latencies = new Float64Array(MEASURE * CYCLE.length);
    let idx = 0;

    const t0 = performance.now();
    for (let i = 0; i < MEASURE; i++) {
      for (const type of CYCLE) {
        const s = performance.now();
        await sk.sendEvent(actorId, { type }, { durability });
        latencies[idx++] = performance.now() - s;
      }
    }
    const elapsed = performance.now() - t0;

    const sorted   = Float64Array.from(latencies).sort();
    const total    = latencies.length;
    const evPerSec = Math.round(total / (elapsed / 1000));
    const p50      = sorted[Math.floor(total * 0.50)] * 1000;
    const p95      = sorted[Math.floor(total * 0.95)] * 1000;
    const p99      = sorted[Math.floor(total * 0.99)] * 1000;

    const label = `StateKeep Postgres (${durability})`;
    const note  = durability === 'sync'
      ? 'Postgres transaction per event, zero crash window'
      : durability === 'async'
      ? 'Postgres — hot registry only, no flush'
      : 'Postgres write buffer, 50ms window';

    results.push({ label, note, evPerSec, p50, p95, p99, totalEvents: total, elapsedMs: elapsed });
  }

  // Concurrent benchmark
  const CONCURRENCY = 10;
  const actors = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => sk.spawnActor({ definitionId }))
  );
  await Promise.all(actors.map(async a => {
    for (const type of CYCLE) await sk.sendEvent(a.id, { type });
  }));

  const EVENTS_PER_ACTOR = 30;
  const totalEvents = CONCURRENCY * EVENTS_PER_ACTOR;
  const t0c = performance.now();
  await Promise.all(actors.map(async a => {
    const cycles = Math.floor(EVENTS_PER_ACTOR / CYCLE.length);
    for (let i = 0; i < cycles; i++) {
      for (const type of CYCLE) await sk.sendEvent(a.id, { type });
    }
  }));
  const elapsedC  = performance.now() - t0c;
  results.push({
    label:      `StateKeep Postgres (${CONCURRENCY} concurrent actors)`,
    note:       'Postgres MVCC — parallel writes without single-writer lock',
    evPerSec:   Math.round(totalEvents / (elapsedC / 1000)),
    totalEvents,
    elapsedMs:  elapsedC,
    concurrent: true,
  });

  await sk.close();

  // Output JSON for parent process to parse
  process.stdout.write('\n__PG_RESULTS__' + JSON.stringify(results) + '__PG_END__\n');
  process.exit(0);
}

run().catch(err => {
  process.stderr.write('[tier4-postgres] Fatal: ' + err.message + '\n' + err.stack + '\n');
  process.exit(1);
});
