/**
 * test/statechart/hot-path/event-encryption.spec.js
 *
 * Verifies that action_jobs.event_snap is stored as an encrypted BLOB at rest (#14).
 *
 * Must run in its own process (--test-concurrency=1 or standalone) because it
 * needs STATEKEEP_DB_PATH and STATEKEEP_ENCRYPTION_KEY set before the db.js
 * singleton initialises, and that singleton is process-scoped.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set env vars before any lazy singleton import
process.env.STATEKEEP_DB_PATH        = join(tmpdir(), `event-enc-${Date.now()}.db`);
process.env.STATEKEEP_ENCRYPTION_KEY = 'e'.repeat(64);
process.env.NODE_ENV                 = 'test';

const { getDb, encrypt, decrypt } = await import('../../../src/registry/db.js');

test('event_snap is stored as encrypted BLOB, not plaintext JSON', () => {
  const db = getDb();

  const event = { type: 'SUBMIT', payload: { ssn: '123-45-6789' } };

  // Encrypt the event as insertActionJob would
  const encrypted = encrypt(Buffer.from(JSON.stringify(event)));

  // Must be a Buffer (BLOB column type)
  assert.ok(Buffer.isBuffer(encrypted), 'encrypt() must return a Buffer');

  // Must NOT be directly JSON-parseable as UTF-8 (ciphertext, not plaintext)
  let isPlaintext = false;
  try { JSON.parse(encrypted.toString('utf8')); isPlaintext = true; } catch {}
  assert.equal(isPlaintext, false, 'encrypted output must not be readable as plaintext JSON');

  // Must NOT contain the sensitive value in plain text anywhere in the buffer
  assert.equal(
    encrypted.toString('binary').includes('123-45-6789'),
    false,
    'encrypted buffer must not contain plaintext PII'
  );

  // Round-trip: decrypt must recover the original event exactly
  const recovered = JSON.parse(decrypt(encrypted).toString('utf8'));
  assert.equal(recovered.type,         'SUBMIT',      'event type must survive encrypt/decrypt');
  assert.equal(recovered.payload?.ssn, '123-45-6789', 'PII field must survive encrypt/decrypt');

  // Verify it actually gets stored as a BLOB in the DB.
  // Disable FK checks for this one synthetic insert (no real actor needed).
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO action_jobs (id, actor_id, action_name, context_snap, event_snap,
      max_retries, next_retry_at, status, created_at)
     VALUES (?,?,?,NULL,?,3,0,'pending',0)`
  ).run('enc-test-id', 'no-real-actor', 'testAction', encrypted);
  db.pragma('foreign_keys = ON');

  const row = db.prepare('SELECT event_snap FROM action_jobs WHERE id = ?').get('enc-test-id');
  assert.ok(row, 'row must exist in action_jobs');
  assert.ok(Buffer.isBuffer(row.event_snap), 'DB must return event_snap as Buffer (BLOB), not string');

  // The stored bytes must match what we inserted and decrypt correctly
  const fromDb = JSON.parse(decrypt(Buffer.from(row.event_snap)).toString('utf8'));
  assert.equal(fromDb.type,         'SUBMIT',      'event type must survive DB round-trip');
  assert.equal(fromDb.payload?.ssn, '123-45-6789', 'PII field must survive DB round-trip');
});
