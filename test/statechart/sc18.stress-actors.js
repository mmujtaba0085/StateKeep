/**
 * test/statechart/sc18.stress-actors.js
 *
 * SC18 — Actor Stress Scenarios
 *
 * SC18-A  Bulk spawn sweep: 100 (always), 1000/5000 (STRESS=1 only)
 * SC18-B  Concurrent event flood: 500 actors × 20 events (STRESS=1)
 * SC18-C  Write buffer saturation: 10 actors × 25 rapid events (always)
 * SC18-D  Migration under concurrent load: 200 actors, deploy v2 mid-flight (STRESS=1)
 *
 * Run:        node --test test/statechart/sc18.stress-actors.js
 * Run (full): STRESS=1 node --test test/statechart/sc18.stress-actors.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn }        from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { post, put, get } from '../setup.js';
import { startServer, stopServer } from '../helpers/serverHelper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = join(__dirname, '..', '..');

const STRESS    = !!process.env.STRESS;
const SKIP_LARGE = STRESS ? false : 'Set STRESS=1 to run large-scale scenarios';

// ── Machine definitions ────────────────────────────────────────────────────────

/** idle → processing → done/failed, linear 4-state machine */
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

/** Adds a 'validating' state between idle and processing — used for migration target */
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Spawn `count` actors via POST /v1/actors/bulk (max 500 per call).
 * Returns array of actor IDs. Throws on any batch failure.
 */
async function bulkSpawn(definitionId, count) {
  const BATCH = 500;
  const ids   = [];
  for (let offset = 0; offset < count; offset += BATCH) {
    const batchSize = Math.min(BATCH, count - offset);
    const actors    = Array.from({ length: batchSize }, (_, i) => ({
      definitionId,
      initialContext: { index: offset + i },
    }));
    const r = await post('/v1/actors/bulk', { actors });
    // Bulk endpoint returns 207 Multi-Status: { created: [...], failed: [...], total: N }
    if (r.status !== 207) throw new Error(`bulkSpawn batch failed (${r.status}): ${JSON.stringify(r.body)}`);
    if (r.body.failed.length > 0) {
      throw new Error(`bulkSpawn: ${r.body.failed.length} actors failed: ${JSON.stringify(r.body.failed[0])}`);
    }
    ids.push(...r.body.created.map(a => a.id));
  }
  return ids;
}

/**
 * Return actor counts by status for a definition.
 * Uses GET /v1/actors?definitionId=X which returns { counts: {active,migrating,...} }.
 */
async function getStatusCounts(definitionId) {
  const r = await get(`/v1/actors?definitionId=${encodeURIComponent(definitionId)}&limit=1`);
  if (r.status !== 200) throw new Error(`getStatusCounts failed (${r.status}): ${JSON.stringify(r.body)}`);
  return r.body.counts; // { active, migrating, needs_rescue, terminated, archived }
}

// ── Top-level server lifecycle ─────────────────────────────────────────────────

before(async () => { await startServer(); });
after(async ()  => { await stopServer(); });

// ─────────────────────────────────────────────────────────────────────────────
// SC18-A: Bulk Spawn Sweep
// ─────────────────────────────────────────────────────────────────────────────

describe('SC18-A: Bulk Spawn Sweep', () => {
  // Each sub-test uses its own definition to avoid cross-test count pollution.

  test('100 actors — all reach active status', async () => {
    const machineId = `sc18-a-100-${Date.now()}`;
    await put('/v1/definitions', { id: machineId, definition: machineV1(machineId) });
    const t0  = Date.now();
    const ids = await bulkSpawn(machineId, 100);
    assert.equal(ids.length, 100, 'Expected 100 actor IDs from bulk spawn');
    const counts = await getStatusCounts(machineId);
    console.log(`  SC18-A 100 actors: ${Date.now() - t0}ms — active=${counts.active}`);
    assert.equal(counts.active, 100, `Expected 100 active, got ${counts.active}`);
    assert.equal(counts.needs_rescue, 0, `${counts.needs_rescue} actors in needs_rescue`);
  });

  test('1000 actors — all reach active status', { skip: SKIP_LARGE }, async () => {
    const machineId = `sc18-a-1k-${Date.now()}`;
    await put('/v1/definitions', { id: machineId, definition: machineV1(machineId) });
    const t0  = Date.now();
    const ids = await bulkSpawn(machineId, 1000);
    const elapsed = Date.now() - t0;
    assert.equal(ids.length, 1000, 'Expected 1000 actor IDs');
    const counts = await getStatusCounts(machineId);
    console.log(`  SC18-A 1000 actors: ${elapsed}ms — active=${counts.active}`);
    assert.ok(elapsed < 30_000, `Spawn took ${elapsed}ms, limit 30s`);
    assert.equal(counts.active, 1000, `Expected 1000 active, got ${counts.active}`);
    assert.equal(counts.needs_rescue, 0, `${counts.needs_rescue} in needs_rescue`);
  });

  test('5000 actors — all reach active status', { skip: SKIP_LARGE }, async () => {
    const machineId = `sc18-a-5k-${Date.now()}`;
    await put('/v1/definitions', { id: machineId, definition: machineV1(machineId) });
    const t0  = Date.now();
    const ids = await bulkSpawn(machineId, 5000);
    const elapsed = Date.now() - t0;
    assert.equal(ids.length, 5000, 'Expected 5000 actor IDs');
    const counts = await getStatusCounts(machineId);
    console.log(`  SC18-A 5000 actors: ${elapsed}ms — active=${counts.active}`);
    assert.ok(elapsed < 120_000, `Spawn took ${elapsed}ms, limit 120s`);
    assert.equal(counts.active, 5000, `Expected 5000 active, got ${counts.active}`);
    assert.equal(counts.needs_rescue, 0, `${counts.needs_rescue} in needs_rescue`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SC18-B: Concurrent Event Flood
// ─────────────────────────────────────────────────────────────────────────────

describe('SC18-B: Concurrent Event Flood', { skip: SKIP_LARGE }, () => {
  const ACTOR_COUNT       = 500;
  const EVENTS_PER_ACTOR  = 20;

  test('500 actors × 20 events concurrent — zero failures, zero needs_rescue', async () => {
    const machineId = `sc18-b-${Date.now()}`;
    await put('/v1/definitions', { id: machineId, definition: machineV1(machineId) });
    const ids = await bulkSpawn(machineId, ACTOR_COUNT);
    assert.equal(ids.length, ACTOR_COUNT, `Expected ${ACTOR_COUNT} actors`);

    // Move all actors to 'processing' (required before FAIL/RETRY events)
    const startResults = await Promise.allSettled(
      ids.map(id => post(`/v1/actors/${id}/event`, { type: 'START' }))
    );
    const startErrors = startResults.filter(r => r.status === 'rejected' || r.value?.status !== 200);
    assert.equal(startErrors.length, 0, `${startErrors.length} START events failed`);

    // Fire EVENTS_PER_ACTOR - 1 additional events per actor concurrently (FAIL/RETRY cycle)
    const eventResults = await Promise.allSettled(
      ids.flatMap(id =>
        Array.from({ length: EVENTS_PER_ACTOR - 1 }, (_, i) =>
          post(`/v1/actors/${id}/event`, { type: i % 2 === 0 ? 'FAIL' : 'RETRY' })
        )
      )
    );

    const errors = eventResults.filter(r => r.status === 'rejected' || r.value?.status >= 500);
    const counts = await getStatusCounts(machineId);
    console.log(`  SC18-B: ${ids.length * EVENTS_PER_ACTOR} total events, ${errors.length} errors, needs_rescue=${counts.needs_rescue}`);

    assert.equal(errors.length, 0, `${errors.length} event requests returned errors`);
    assert.equal(counts.needs_rescue, 0, `${counts.needs_rescue} actors in needs_rescue`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SC18-C: Write Buffer Saturation
// ─────────────────────────────────────────────────────────────────────────────

describe('SC18-C: Write Buffer Saturation', () => {
  // 10 actors × 25 events = 250 total, which exceeds HIGH_WATER mark (200)
  // This triggers an immediate flush mid-cycle — verifies no data loss under saturation.
  const ACTOR_COUNT      = 10;
  const EVENTS_PER_ACTOR = 25;

  test('250 rapid events exceed HIGH_WATER(200) — no data loss, no needs_rescue', async () => {
    const machineId = `sc18-c-${Date.now()}`;
    await put('/v1/definitions', { id: machineId, definition: machineV1(machineId) });
    const ids = await bulkSpawn(machineId, ACTOR_COUNT);

    // Fire all events concurrently without awaiting between sends.
    // First event per actor is START, rest alternate FAIL/RETRY.
    const results = await Promise.allSettled(
      ids.flatMap(id =>
        Array.from({ length: EVENTS_PER_ACTOR }, (_, i) => {
          const type = i === 0 ? 'START' : i % 2 === 1 ? 'FAIL' : 'RETRY';
          return post(`/v1/actors/${id}/event`, { type });
        })
      )
    );

    const failures = results.filter(r => r.status === 'rejected' || r.value?.status >= 500);
    const counts   = await getStatusCounts(machineId);
    console.log(`  SC18-C: ${ACTOR_COUNT * EVENTS_PER_ACTOR} events, ${failures.length} failures, needs_rescue=${counts.needs_rescue}`);

    assert.equal(failures.length, 0,         `${failures.length} events failed under write-buffer saturation`);
    assert.equal(counts.needs_rescue, 0,     `${counts.needs_rescue} actors in needs_rescue after saturation`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SC18-D: Migration Under Concurrent Load
// ─────────────────────────────────────────────────────────────────────────────

describe('SC18-D: Migration Under Concurrent Load', { skip: SKIP_LARGE }, () => {
  const ACTOR_COUNT = 200;
  let actorIds      = [];
  let machineId;
  let defV1Id;
  let defV2Id;
  let migrateWorker = null;

  before(async () => {
    // Unique machine family ID shared by v1 and v2 definitions
    machineId = `sc18-d-machine-${Date.now()}`;
    defV1Id   = `${machineId}-v1`;
    defV2Id   = `${machineId}-v2`;

    // Deploy v1 and spawn 200 actors
    await put('/v1/definitions', { id: defV1Id, definition: machineV1(machineId) });
    actorIds = await bulkSpawn(defV1Id, ACTOR_COUNT);
    assert.equal(actorIds.length, ACTOR_COUNT, `Expected ${ACTOR_COUNT} actors spawned`);

    // Start migrate-worker as a child process — it inherits process.env which has
    // STATEKEEP_DB_PATH and STATEKEEP_ENCRYPTION_KEY set by test/setup.js.
    migrateWorker = spawn(
      process.execPath,
      [join(ROOT, 'src', 'workers', 'migrate-worker.js')],
      { env: { ...process.env }, stdio: 'pipe' }
    );
    migrateWorker.stderr.on('data', chunk =>
      process.stderr.write(`[sc18-d migrate-worker] ${chunk}`)
    );
    migrateWorker.on('error', err =>
      console.error('[sc18-d migrate-worker] spawn error:', err.message)
    );
    // Give worker 1s to initialise and register with the DB
    await new Promise(r => setTimeout(r, 1000));
  });

  after(async () => {
    if (migrateWorker) {
      migrateWorker.kill('SIGTERM');
      migrateWorker = null;
    }
  });

  test('deploy v2 mid-flight — no actor ends in needs_rescue, no event errors', async () => {
    // Deploy v2 of the same machine family — triggers migration job creation for all v1 actors
    const deployR = await put('/v1/definitions', { id: defV2Id, definition: machineV2(machineId) });
    assert.ok(
      [200, 201].includes(deployR.status),
      `Deploy v2 failed (${deployR.status}): ${JSON.stringify(deployR.body)}`
    );

    // Immediately send START events to all actors concurrently (race with migration)
    const eventResults = await Promise.allSettled(
      actorIds.map(id => post(`/v1/actors/${id}/event`, { type: 'START' }))
    );
    const eventErrors = eventResults.filter(
      r => r.status === 'rejected' || (r.value?.status >= 500)
    );

    // Poll until migration settles: all actors are either active or needs_rescue (none migrating)
    // Timeout: 60 seconds
    const deadline = Date.now() + 60_000;
    let counts;
    while (Date.now() < deadline) {
      counts = await getStatusCounts(defV1Id);
      if (counts.migrating === 0) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log(
      `  SC18-D: active=${counts.active} migrating=${counts.migrating} ` +
      `needs_rescue=${counts.needs_rescue} eventErrors=${eventErrors.length}`
    );

    assert.equal(counts.migrating,    0, `${counts.migrating} actors still migrating after 60s`);
    assert.equal(counts.needs_rescue, 0, `${counts.needs_rescue} actors in needs_rescue after migration`);
    assert.equal(eventErrors.length,  0, `${eventErrors.length} events errored during migration`);
  });
});
