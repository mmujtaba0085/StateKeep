/**
 * A flush whose transaction fails must not lose the batch: durable() rejects (so no
 * request is acknowledged) and the rows are written by the next flush.
 * Found by the workflow chaos simulation: dropping every database connection lost
 * events that had already been processed in memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { WriteBuffer } from '../src/runtime/writeBuffer.js';

// The buffer's retry logic is shared by both backends; this drives it through an
// in-memory SQLite database, so it runs only in SQLite mode.
const skip = process.env.STATEKEEP_DB_URL ? 'SQLite-level unit test (Postgres mode)' : false;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE actors (id TEXT PRIMARY KEY, state_value TEXT, context_json BLOB, history_fingerprint TEXT,
      region_fingerprints TEXT, last_event_tick INTEGER, state_entry_id INTEGER, status TEXT, updated_at INTEGER);
    CREATE TABLE events (id INTEGER PRIMARY KEY, actor_id TEXT, event_type TEXT, event_payload BLOB, tick INTEGER,
      processed_at INTEGER, idempotency_key TEXT, UNIQUE(actor_id, idempotency_key));
    CREATE TABLE migration_decisions (actor_id TEXT, deployment_id TEXT, trigger TEXT, evaluated_at INTEGER, decision TEXT,
      reason TEXT, from_definition_id TEXT, to_definition_id TEXT, actor_fingerprint TEXT, prefix_hash TEXT, created_at INTEGER);
    CREATE TABLE scheduled_events (id INTEGER PRIMARY KEY, actor_id TEXT, event_type TEXT, payload_enc BLOB, fire_at INTEGER,
      status TEXT, created_at INTEGER);
    CREATE TABLE action_jobs (id TEXT PRIMARY KEY, actor_id TEXT, action_name TEXT, context_snap BLOB, event_snap BLOB,
      max_retries INTEGER, next_retry_at INTEGER, status TEXT, created_at INTEGER);
    INSERT INTO actors (id, state_value, status) VALUES ('a1', '"idle"', 'active');
  `);
  let failures = 0;
  const flaky = new Proxy(db, {
    get(target, prop) {
      if (prop === 'transaction') {
        return (fn) => {
          const tx = target.transaction(fn);
          return (...args) => { if (failures > 0) { failures--; throw new Error('connection terminated'); } return tx(...args); };
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { db, flaky, failNext: (n = 1) => { failures = n; } };
}

test('a failed flush is retried, never dropped, and durable() reports the failure', { skip }, async () => {
  const { db, flaky, failNext } = makeDb();
  const buf = new WriteBuffer(flaky);
  clearInterval(buf._timer);

  buf.queueState('a1', { stateValue: 'working', context: { n: 1 }, historyFingerprint: '7', status: 'active' });
  buf.queueEvent({ actor_id: 'a1', event_type: 'START', event_payload: null, tick: 1, processed_at: 1, idempotency_key: 'k1' });
  buf.queueActionJob({ actorId: 'a1', actionName: 'doIt', context: {}, event: { type: 'START' } });
  buf.queueScheduledCreate({ actorId: 'a1', eventType: '__SK_TIMEOUT_working_100', fireAt: 5, payload: {} });

  failNext(100);   // a long outage: every retry fails, so durable() reports it
  await assert.rejects(buf.durable(), /connection terminated/);
  failNext(0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM events').get().c, 0);
  assert.ok(buf.hasPendingEvent('a1', 'k1'), 'the event still counts as pending, so a retry is a duplicate');

  // a newer state for the same actor arrives before the retry: it must win
  buf.queueState('a1', { stateValue: 'done', context: { n: 2 }, historyFingerprint: '9', status: 'active' });
  buf.queueEvent({ actor_id: 'a1', event_type: 'FINISH', event_payload: null, tick: 2, processed_at: 2, idempotency_key: 'k2' });
  await buf.durable();

  assert.deepEqual(db.prepare('SELECT event_type FROM events ORDER BY id').all().map((r) => r.event_type), ['START', 'FINISH']);
  assert.equal(db.prepare(`SELECT state_value FROM actors WHERE id='a1'`).get().state_value, '"done"');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM action_jobs').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scheduled_events').get().c, 1);
});

test('durable() rides out a short outage and then succeeds', { skip }, async () => {
  const { db, flaky, failNext } = makeDb();
  const buf = new WriteBuffer(flaky);
  clearInterval(buf._timer);
  buf.queueEvent({ actor_id: 'a1', event_type: 'START', event_payload: null, tick: 1, processed_at: 1, idempotency_key: 'k1' });
  failNext(2);
  await buf.durable();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM events').get().c, 1);
});

test('flushActor keeps the row when its write fails', { skip }, async () => {
  const { db, flaky } = makeDb();
  const buf = new WriteBuffer(flaky);
  clearInterval(buf._timer);
  buf.queueState('a1', { stateValue: 'working', context: {}, historyFingerprint: '1', status: 'active' });
  buf._stmts = null;
  const real = buf._getStmts.bind(buf);
  let broken = true;
  buf._getStmts = () => { const s = real(); return broken ? { ...s, state: { run() { throw new Error('disk I/O error'); } } } : s; };
  await assert.rejects(buf.flushActor('a1'), /disk I\/O/);
  broken = false;
  await buf.flush();
  assert.equal(db.prepare(`SELECT state_value FROM actors WHERE id='a1'`).get().state_value, '"working"');
});
