/**
 * test/statechart/sc19.probabilistic-stress.js
 *
 * SC19 — Probabilistic Concurrent Stress
 *
 * A chaos/fuzz harness, not a business-logic oracle. Every trial rolls an
 * independent Bernoulli trial for EACH possibility against its own probability —
 * not a weighted single pick — so zero, one, or all of them can fire in the same
 * trial. Whatever fires in a trial runs concurrently via Promise.allSettled,
 * modeling real traffic where spawns, events, deletes, migrations, and worker
 * restarts land on the server at the same instant.
 *
 * Because the mix is random, this test does not assert exact state transitions
 * (sc9-sc18 already cover those deterministically). It asserts the server
 * survives: no 5xx, no thrown/network errors, no runaway needs_rescue, and the
 * health endpoint still responds after the storm.
 *
 * Run:        node --test test/statechart/sc19.probabilistic-stress.js
 * Run (full): STRESS=1 node --test test/statechart/sc19.probabilistic-stress.js
 *
 * STRESS=1 raises trials from 60 to 350+ and unlocks migration/worker-restart
 * chaos (skipped by default — both are expensive and migration needs a live
 * migrate-worker process).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { get, post, put, del, request } from '../setup.js';
import { startServer, stopServer } from '../helpers/serverHelper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = join(__dirname, '..', '..');

const STRESS     = !!process.env.STRESS;
const NUM_TRIALS = STRESS ? 350 : 60;
const RUN_ID     = Date.now();

// ── Machine definitions ─────────────────────────────────────────────────────

const machineV1 = (machineId) => ({
  id:      machineId,
  initial: 'idle',
  states: {
    idle:       { on: { START: 'processing' } },
    processing: { on: { COMPLETE: 'done', FAIL: 'failed' } },
    failed:     { on: { RETRY: 'processing' } },
    done:       { type: 'final' },
  },
});

const machineV2 = (machineId) => ({
  id:      machineId,
  initial: 'idle',
  states: {
    idle:       { on: { START: 'validating' } },
    validating: { on: { OK: 'processing' } },
    processing: { on: { COMPLETE: 'done', FAIL: 'failed' } },
    failed:     { on: { RETRY: 'processing' } },
    done:       { type: 'final' },
  },
});

const VALID_EVENTS = ['START', 'COMPLETE', 'FAIL', 'RETRY', 'OK'];

// ── Shared mutable state for the run ─────────────────────────────────────────

const pool = {
  actorIds:          [],
  archivedIds:       [],
  scheduleIds:       [],
  webhookIds:        [],
  migrationDeployed: false,
};

const tally = {
  attempted:   0,
  ok:          0,
  expected4xx: 0,
  unexpected:  [], // { name, status, body }
};

function pick(arr) {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}

async function record(name, fn) {
  tally.attempted++;
  try {
    const r = await fn();
    if (r == null) return r;
    if (r.status >= 500) {
      tally.unexpected.push({ name, status: r.status, body: r.body });
    } else if (r.status >= 400) {
      tally.expected4xx++;
    } else {
      tally.ok++;
    }
    return r;
  } catch (err) {
    tally.unexpected.push({ name, status: 'throw', body: err.message });
    return null;
  }
}

// ── Possibility pool: each fires independently at its own probability ───────

function buildPossibilities(defV1, defV2, machineId) {
  return [
    {
      name: 'spawnSingle', probability: 0.35,
      run: () => record('spawnSingle', async () => {
        const defId = Math.random() < 0.5 ? defV1 : defV2;
        const r = await post('/v1/actors', { definitionId: defId, initialContext: { seq: pool.actorIds.length } });
        if (r.status === 201) pool.actorIds.push(r.body.id);
        return r;
      }),
    },
    {
      name: 'spawnBulk', probability: 0.08,
      run: () => record('spawnBulk', async () => {
        const defId = Math.random() < 0.5 ? defV1 : defV2;
        const n = 2 + Math.floor(Math.random() * 18);
        const actors = Array.from({ length: n }, (_, i) => ({ definitionId: defId, initialContext: { i } }));
        const r = await post('/v1/actors/bulk', { actors });
        if (r.status === 207) pool.actorIds.push(...r.body.created.map(a => a.id));
        return r;
      }),
    },
    {
      name: 'sendValidEvent', probability: 0.55,
      run: () => record('sendValidEvent', async () => {
        const id = pick(pool.actorIds);
        if (!id) return null;
        return post(`/v1/actors/${id}/event`, { type: pick(VALID_EVENTS) });
      }),
    },
    {
      name: 'sendGarbageEvent', probability: 0.15,
      run: () => record('sendGarbageEvent', async () => {
        const id = pick(pool.actorIds);
        if (!id) return null;
        return post(`/v1/actors/${id}/event`, { type: `GARBAGE_${randomUUID().slice(0, 8)}` });
      }),
    },
    {
      name: 'batchEvents', probability: 0.12,
      run: () => record('batchEvents', async () => {
        const id = pick(pool.actorIds);
        if (!id) return null;
        const events = Array.from({ length: 2 + Math.floor(Math.random() * 3) }, () => ({ type: pick(VALID_EVENTS) }));
        return post(`/v1/actors/${id}/events/batch`, { events });
      }),
    },
    {
      name: 'concurrentFloodBurst', probability: 0.03,
      run: () => record('concurrentFloodBurst', async () => {
        const ids = pool.actorIds.slice(-20);
        if (ids.length === 0) return null;
        const results = await Promise.allSettled(ids.map(id => post(`/v1/actors/${id}/event`, { type: 'START' })));
        const bad = results.find(r => r.status === 'rejected' || r.value?.status >= 500);
        return bad ? { status: 500, body: bad } : { status: 200 };
      }),
    },
    {
      name: 'patchRescue', probability: 0.05,
      run: () => record('patchRescue', async () => {
        const id = pick(pool.actorIds);
        if (!id) return null;
        return request('PATCH', `/v1/actors/${id}`, { status: 'active' });
      }),
    },
    {
      name: 'deleteActor', probability: 0.06,
      run: () => record('deleteActor', async () => {
        const id = pick(pool.actorIds);
        if (!id) return null;
        return del(`/v1/actors/${id}`);
      }),
    },
    {
      name: 'forceArchive', probability: 0.05,
      run: () => record('forceArchive', async () => {
        const id = pick(pool.actorIds);
        if (!id) return null;
        const r = await post(`/v1/admin/actors/${id}/force-archive`);
        if (r.status === 200 || r.status === 201) pool.archivedIds.push(id);
        return r;
      }),
    },
    {
      name: 'restoreActor', probability: 0.05,
      run: () => record('restoreActor', async () => {
        const id = pick(pool.archivedIds);
        if (!id) return null;
        return post(`/v1/actors/${id}/restore`);
      }),
    },
    {
      name: 'scheduleEvent', probability: 0.08,
      run: () => record('scheduleEvent', async () => {
        const id = pick(pool.actorIds);
        if (!id) return null;
        const r = await post(`/v1/actors/${id}/schedule`, {
          type:   pick(VALID_EVENTS),
          fireAt: Date.now() + 500 + Math.floor(Math.random() * 3000),
        });
        if (r.status === 201) pool.scheduleIds.push({ actorId: id, schedId: r.body.id });
        return r;
      }),
    },
    {
      name: 'cancelSchedule', probability: 0.05,
      run: () => record('cancelSchedule', async () => {
        const entry = pick(pool.scheduleIds);
        if (!entry) return null;
        return del(`/v1/actors/${entry.actorId}/schedule/${entry.schedId}`);
      }),
    },
    {
      name: 'createWebhook', probability: 0.03,
      run: () => record('createWebhook', async () => {
        const r = await post('/v1/webhooks', {
          url:    'http://localhost:9/nowhere',
          secret: `sc19-secret-${randomUUID()}`,
          events: ['state.changed'],
        });
        if (r.status === 201) pool.webhookIds.push(r.body.id);
        return r;
      }),
    },
    {
      name: 'pingWebhook', probability: 0.03,
      run: () => record('pingWebhook', async () => {
        const id = pick(pool.webhookIds);
        if (!id) return null;
        return post(`/v1/webhooks/${id}/ping`);
      }),
    },
    {
      name: 'deleteWebhook', probability: 0.02,
      run: () => record('deleteWebhook', async () => {
        const id = pick(pool.webhookIds);
        if (!id) return null;
        return del(`/v1/webhooks/${id}`);
      }),
    },
    {
      name: 'readActor', probability: 0.2,
      run: () => record('readActor', async () => {
        const id = pick(pool.actorIds);
        if (!id) return null;
        return get(`/v1/actors/${id}`);
      }),
    },
    {
      name: 'readActorState', probability: 0.15,
      run: () => record('readActorState', async () => {
        const id = pick(pool.actorIds);
        if (!id) return null;
        return get(`/v1/actors/${id}/state`);
      }),
    },
    {
      name: 'readActorEvents', probability: 0.1,
      run: () => record('readActorEvents', async () => {
        const id = pick(pool.actorIds);
        if (!id) return null;
        return get(`/v1/actors/${id}/events`);
      }),
    },
    {
      name: 'readActorDecisions', probability: 0.1,
      run: () => record('readActorDecisions', async () => {
        const id = pick(pool.actorIds);
        if (!id) return null;
        return get(`/v1/actors/${id}/decisions`);
      }),
    },
    {
      name: 'readHealthQueues', probability: 0.1,
      run: () => record('readHealthQueues', async () => get('/v1/health/queues')),
    },
    {
      name: 'readMetrics', probability: 0.1,
      run: () => record('readMetrics', async () => get('/v1/metrics')),
    },
    {
      name: 'listActionJobs', probability: 0.05,
      run: () => record('listActionJobs', async () => get('/v1/action-jobs?outcome=unknown')),
    },
    {
      name: 'restartActorWorkers', probability: STRESS ? 0.02 : 0,
      run: () => record('restartActorWorkers', async () => post('/v1/admin/workers/actor/restart')),
    },
    {
      // One-shot: deploys a v2 with parentId against a fresh batch of actors,
      // handing the resulting migrating actors into the general pool so later
      // trials race ordinary events against the in-flight migration.
      name: 'deployMigration', probability: STRESS ? 0.01 : 0,
      run: () => record('deployMigration', async () => {
        if (pool.migrationDeployed) return null;
        pool.migrationDeployed = true;
        const migMachineId = `sc19-mig-${machineId}`;
        const migV1 = `${migMachineId}-v1`;
        const migV2 = `${migMachineId}-v2`;
        await put('/v1/definitions', { id: migV1, definition: machineV1(migMachineId) });
        const spawned = await post('/v1/actors/bulk', {
          actors: Array.from({ length: 50 }, (_, i) => ({ definitionId: migV1, initialContext: { i } })),
        });
        if (spawned.status === 207) pool.actorIds.push(...spawned.body.created.map(a => a.id));
        return put('/v1/definitions', { id: migV2, definition: machineV2(migMachineId), parentId: migV1 });
      }),
    },
  ];
}

// ── Top-level server + migrate-worker lifecycle ──────────────────────────────

let migrateWorker = null;
let defV1, defV2;

before(async () => {
  await startServer();

  if (STRESS) {
    migrateWorker = spawn(
      process.execPath,
      [join(ROOT, 'src', 'workers', 'migrate-worker.js')],
      { env: { ...process.env }, stdio: 'pipe' }
    );
    migrateWorker.stderr.on('data', chunk => process.stderr.write(`[sc19 migrate-worker] ${chunk}`));
    migrateWorker.on('error', err => console.error('[sc19 migrate-worker] spawn error:', err.message));
    await new Promise(r => setTimeout(r, 1000));
  }

  const machineId = `sc19-${RUN_ID}`;
  defV1 = `${machineId}-v1`;
  defV2 = `${machineId}-v2`;
  await put('/v1/definitions', { id: defV1, definition: machineV1(`${machineId}-a`) });
  await put('/v1/definitions', { id: defV2, definition: machineV2(`${machineId}-b`) });
});

after(async () => {
  if (migrateWorker) {
    migrateWorker.kill('SIGTERM');
    await Promise.race([
      new Promise(r => migrateWorker.once('exit', r)),
      new Promise(r => setTimeout(r, 3000)),
    ]);
    migrateWorker = null;
  }
  await stopServer();
});

// ── The stress run ────────────────────────────────────────────────────────────

describe('SC19: Probabilistic Concurrent Stress', () => {
  test(`${NUM_TRIALS} trials, independent per-possibility probabilities, concurrent firing`, { timeout: 180_000 }, async () => {
    const machineId = `sc19-${RUN_ID}`;
    const possibilities = buildPossibilities(defV1, defV2, machineId);

    for (let trial = 0; trial < NUM_TRIALS; trial++) {
      const firing = possibilities.filter(p => Math.random() < p.probability);
      if (firing.length === 0) continue;
      await Promise.allSettled(firing.map(p => p.run()));
    }

    // Let any last-second scheduled events / migrations settle before checking state.
    await new Promise(r => setTimeout(r, 2000));

    console.log(
      `SC19: ${tally.attempted} actions attempted — ok=${tally.ok} ` +
      `expected4xx=${tally.expected4xx} unexpected=${tally.unexpected.length} actors=${pool.actorIds.length}`
    );
    if (tally.unexpected.length > 0) {
      console.log('SC19 unexpected failures (first 10):', JSON.stringify(tally.unexpected.slice(0, 10), null, 2));
    }

    const minAttempts = STRESS ? 300 : NUM_TRIALS;
    assert.ok(tally.attempted >= minAttempts, `Only ${tally.attempted} actions attempted — expected ${minAttempts}+`);
    assert.equal(tally.unexpected.length, 0, `${tally.unexpected.length} unexpected 5xx/thrown errors — see log above`);

    const health = await get('/v1/health');
    assert.equal(health.status, 200, 'server unresponsive after stress run');

    const rescueR = await get('/v1/actors/needs-rescue?limit=200');
    const rescueCount = Array.isArray(rescueR.body?.actors) ? rescueR.body.actors.length : 0;
    console.log(`SC19: needs_rescue=${rescueCount} / ${pool.actorIds.length} actors spawned`);
    assert.ok(
      rescueCount < Math.max(10, pool.actorIds.length * 0.5),
      `${rescueCount}/${pool.actorIds.length} actors stuck in needs_rescue — likely a real bug, not chaos noise`
    );
  });
});
