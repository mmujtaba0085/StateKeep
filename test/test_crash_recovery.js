/**
 * test/test_crash_recovery.js
 * Proves: after process restart, actor state is consistent (loaded from SQLite)
 *
 * Strategy: write directly to SQLite (simulating what the API does after an event),
 * then verify the actorRepo can read it back correctly with decryption.
 * Full process kill/restart is an integration concern handled in OPS.md.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { seedApiKey, post, put, get, SAMPLE_MACHINE_V1 } from './setup.js';

before(async () => {
  await seedApiKey();
  // seed definition directly into DB (no server needed for DB-level recovery tests)
  const { getDb } = await import('../src/registry/db.js');
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO definitions (id, parent_id, definition_json, deployed_at, status)
    VALUES ('crash-test-v1', NULL, ?, 1, 'active')
  `).run(JSON.stringify(SAMPLE_MACHINE_V1));
});

test('actor state written to SQLite is readable after in-process reload', async () => {
  const { getDb, encrypt, decrypt } = await import('../src/registry/db.js');
  const { createActor, findActorById, updateActorState } = await import('../src/registry/actorRepo.js');
  const db = getDb();

  const actorId = 'crash-test-' + Date.now();
  createActor({
    id:            actorId,
    definitionId:  'crash-test-v1',
    orgId:         'crash-test-org',
    stateValue:    'running',
    context:       { sessionId: 'abc123', retries: 3 },
    logicalStartTick: 100,
    historyFingerprint: 'deadbeef12345678',
  });

  // Simulate event + state update
  updateActorState(actorId, {
    stateValue:         'paused',
    context:            { sessionId: 'abc123', retries: 2, pausedAt: 9999 },
    historyFingerprint: 'cafebabe87654321',
    lastEventTick:      101,
    status:             'active',
  });

  // Reload from DB (simulates restart — no in-memory cache)
  const actor = findActorById(actorId);
  assert.ok(actor, 'Actor should be loadable from SQLite');
  assert.equal(actor.stateValue, 'paused', 'State value should be persisted');
  assert.deepEqual(actor.context, { sessionId: 'abc123', retries: 2, pausedAt: 9999 },
    'Context should be decrypted correctly');
  assert.equal(actor.historyFingerprint, 'cafebabe87654321');
  assert.equal(actor.lastEventTick, 101);
  assert.equal(actor.status, 'active');
});

test('context encryption round-trip is lossless', async () => {
  const { encrypt, decrypt } = await import('../src/registry/db.js');

  const original = { nested: { a: 1 }, arr: [1, 2, 3], str: 'hello', flag: true };
  const plaintext = JSON.stringify(original);

  const ciphertext = encrypt(Buffer.from(plaintext));
  const recovered  = decrypt(ciphertext).toString('utf8');
  assert.deepEqual(JSON.parse(recovered), original, 'Encrypt/decrypt round-trip failed');
});

test('actor with null context is handled gracefully', async () => {
  const { createActor, findActorById } = await import('../src/registry/actorRepo.js');

  const id = 'null-ctx-' + Date.now();
  createActor({
    id,
    definitionId:  'crash-test-v1',
    orgId:         'crash-test-org',
    stateValue:    'idle',
    context:       null,
    logicalStartTick: 0,
    historyFingerprint: '0',
  });

  const actor = findActorById(id);
  assert.ok(actor, 'Actor should be found');
  assert.equal(actor.context, null, 'Null context should round-trip as null');
});
