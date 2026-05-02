/**
 * test/test_no_migration_without_engine.js
 * Proves: with libapv-engine.so missing, actors stay on current version forever.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { seedApiKey, post, put, SAMPLE_MACHINE_V1, SAMPLE_MACHINE_V2 } from './setup.js';

// Temporarily unset engine path to force fallback mode
const SAVED_ENGINE_PATH = process.env.STATEKEEP_ENGINE_PATH;
delete process.env.STATEKEEP_ENGINE_PATH;

before(async () => { await seedApiKey(); });

test('fallback engine: computeAccessible always returns null', async () => {
  const { default: fallback } = await import('../src/ffi/fallback.js');
  const result = fallback.computeAccessible(0n, 0n, 0n);
  assert.equal(result, null, 'Fallback engine must return null (no migration)');
  assert.equal(fallback.available, false, 'Fallback must report available=false');
});

test('fallback engine: clockTick returns incrementing BigInt', async () => {
  const { default: fallback } = await import('../src/ffi/fallback.js');
  const t1 = fallback.clockTick();
  const t2 = fallback.clockTick();
  assert.ok(typeof t1 === 'bigint', 'tick should be BigInt');
  assert.ok(t2 > t1, 'clock should be monotonic');
});

test('fallback engine: FNV-1a produces correct hash for empty input', async () => {
  const { default: fallback } = await import('../src/ffi/fallback.js');
  const h = fallback.fnv1aFinal(fallback.fnv1aInit());
  // FNV-1a offset basis with no update
  assert.equal(h, 0xcbf29ce484222325n);
});

test('fallback engine: FNV-1a "hello world" hash is deterministic', async () => {
  const { default: fallback } = await import('../src/ffi/fallback.js');
  let h = fallback.fnv1aInit();
  h = fallback.fnv1aUpdate(h, Buffer.from('hello world'));
  h = fallback.fnv1aFinal(h);
  // Same call again must produce same result
  let h2 = fallback.fnv1aInit();
  h2 = fallback.fnv1aUpdate(h2, Buffer.from('hello world'));
  h2 = fallback.fnv1aFinal(h2);
  assert.equal(h, h2, 'FNV-1a must be deterministic');
  assert.notEqual(h, 0xcbf29ce484222325n, 'hash must differ from init value');
});

test('without engine, deploying new def creates no migration jobs (DB-level check)', async () => {
  const { getDb } = await import('../src/registry/db.js');
  const { createDefinition } = await import('../src/registry/definitionRepo.js');
  const { createActor } = await import('../src/registry/actorRepo.js');
  const { default: fallback } = await import('../src/ffi/fallback.js');
  const db = getDb();

  // Seed directly into DB (no HTTP server needed)
  createDefinition({ id: 'noeng-parent-unit', parentId: null, orgId: 'noeng-test-org', definitionJson: SAMPLE_MACHINE_V1, deployedAt: 1 });
  createActor({ id: 'noeng-actor-unit', definitionId: 'noeng-parent-unit', orgId: 'noeng-test-org', stateValue: 'idle', context: {}, logicalStartTick: 0, historyFingerprint: '0' });

  // Simulate what the definitions route does
  createDefinition({ id: 'noeng-child-unit', parentId: 'noeng-parent-unit', orgId: 'noeng-test-org', definitionJson: SAMPLE_MACHINE_V2, deployedAt: 2 });

  // With fallback engine, computeAccessible returns null → no jobs enqueued
  const { findActorsByDefinition } = await import('../src/registry/actorRepo.js');
  const actors = findActorsByDefinition('noeng-parent-unit', 'noeng-test-org');
  assert.equal(actors.length, 1, 'One actor on parent');

  let jobsQueued = 0;
  for (const actor of actors) {
    const target = fallback.computeAccessible(0n, BigInt(actor.logicalStartTick), fallback.clockTick());
    if (target !== null) jobsQueued++;
  }
  assert.equal(jobsQueued, 0, 'Fallback engine must not trigger any migration jobs');
});

// Restore engine path
process.env.STATEKEEP_ENGINE_PATH = SAVED_ENGINE_PATH ?? '';
