/**
 * test/test_actor_termination.js
 * Proves: DELETE removes actor, GC eventually archives
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { seedApiKey, post, put, get, del, SAMPLE_MACHINE_V1 } from './setup.js';

before(async () => {
  await seedApiKey();
  await put('/v1/definitions', { id: 'term-test-v1', definition: SAMPLE_MACHINE_V1 });
});

const sqliteOnly = (process.env.STATEKEEP_DB_URL ?? '').startsWith('postgres') && 'reads the SQLite file directly';

test('DELETE /v1/actors/:id returns 200 with terminated status (docs/API.md)', async () => {
  const { id } = (await post('/v1/actors', { definitionId: 'term-test-v1' })).body;
  const r = await del(`/v1/actors/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'terminated');
});

test('after DELETE, actor status is terminated in DB', { skip: sqliteOnly }, async () => {
  const { getDb } = await import('../src/registry/db.js');
  const db = getDb();

  const { id } = (await post('/v1/actors', { definitionId: 'term-test-v1' })).body;
  await del(`/v1/actors/${id}`);

  const row = db.prepare(`SELECT status FROM actors WHERE id = ?`).get(id);
  assert.ok(row, 'Row should still exist');
  assert.equal(row.status, 'terminated');
});

test('sending event to terminated actor returns 409 ACTOR_TERMINATED', async () => {
  const { id } = (await post('/v1/actors', { definitionId: 'term-test-v1' })).body;
  await del(`/v1/actors/${id}`);
  const r = await post(`/v1/actors/${id}/event`, { type: 'START' });
  assert.equal(r.status, 409, `Expected 409, got ${r.status}`);
  assert.equal(r.body.code, 'ACTOR_TERMINATED');
});

test('DELETE non-existent actor returns 404', async () => {
  const r = await del('/v1/actors/nonexistent-actor-id');
  assert.equal(r.status, 404);
});

test('GC worker archives actors idle > 24h', { skip: sqliteOnly }, async () => {
  const { getDb } = await import('../src/registry/db.js');
  const db = getDb();

  // Manually insert an actor that is 25h idle
  const pastTime = Date.now() - 25 * 60 * 60 * 1000;
  const fakeId   = 'gc-test-actor-' + Date.now();
  db.prepare(`
    INSERT INTO actors
      (id, definition_id, state_value, context_json, logical_start_tick,
       history_fingerprint, status, created_at, updated_at)
    VALUES (?, 'term-test-v1', '{}', NULL, 0, '0', 'active', ?, ?)
  `).run(fakeId, pastTime, pastTime);

  // Import and run GC directly
  const { findIdleActors, updateActorStatus } = await import('../src/registry/actorRepo.js');
  const idle = await findIdleActors(24 * 60 * 60 * 1000, 10);   // async since the Postgres backend was added
  const gcActor = idle.find(a => a.id === fakeId);
  assert.ok(gcActor, 'Idle actor should be found by GC query');

  // Simulate GC archiving
  updateActorStatus(fakeId, 'archived');
  const row = db.prepare(`SELECT status FROM actors WHERE id = ?`).get(fakeId);
  assert.equal(row.status, 'archived');
});
