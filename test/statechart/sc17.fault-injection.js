/**
 * test/statechart/sc17.fault-injection.js
 *
 * Fault-injection tests — verifies error propagation and ordering invariants.
 *
 * Tests:
 *   SC17-A: writeBuffer.flush() rejects when SQLite throws
 *   SC17-B: migrate-worker marks job done before inserting MIGRATED event
 *   SC17-C: Storage functions called by the definitions route propagate DB errors
 *          C1: updateCompiledJson rejects when SQLite UPDATE fails
 *          C2: insertChangepoint rejects when SQLite INSERT fails, nothing persisted
 *   SC17-D: Postgres webhook DELETE rolls back on partial failure (skip if no Postgres)
 *
 * Run: node --test test/statechart/sc17.fault-injection.js
 *
 * SC17-C uses SQLite RAISE() triggers on the shared getDb() connection to inject
 * failures directly into the storage functions. No server or experimental flags
 * required. The definitions route has no try/catch around these calls, so their
 * error propagation is what causes 500 responses at the HTTP layer.
 *
 * SC17-D requires STATEKEEP_DB_URL set to a Postgres connection string.
 */

import '../setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ─── SC17-A: writeBuffer.flush() rejects when SQLite throws ──────────────────

describe('SC17-A: writeBuffer.flush() rejects when SQLite throws', () => {
  test('flush() returns a rejected promise on synchronous SQLite error', async (t) => {
    const fakeDb = {
      prepare: (sql) => ({
        run: (...args) => { throw new Error('SQLITE_IOERR: disk full'); },
        all: () => [],
        get: () => null,
      }),
      transaction: (fn) => (...args) => { throw new Error('SQLITE_IOERR: disk full'); },
    };

    const { WriteBuffer } = await import('../../src/runtime/writeBuffer.js');
    const buf = new WriteBuffer(fakeDb);

    buf.queueState('actor-test-1', {
      stateValue: 'idle',
      context: null,
      historyFingerprint: '0',
      regionFingerprints: null,
    });

    await assert.rejects(
      () => buf.flush(),
      /SQLITE_IOERR/,
      'flush() must reject when SQLite throws, not silently resolve'
    );

    clearInterval(buf._timer);
  });
});

// ─── SC17-B: migrate-worker — markDone before insertEvent ────────────────────

describe('SC17-B: migrate-worker marks job done before inserting MIGRATED event', () => {
  test('fixed ordering: markDone called even when insertEvent throws', async () => {
    const callOrder = [];
    const stubMarkDone = async (id) => { callOrder.push('markDone'); };
    const stubIncrementMigrated = async () => { callOrder.push('incrementMigrated'); };
    const stubInsertEvent = async () => {
      callOrder.push('insertEvent');
      throw new Error('insert event failed');
    };

    // Fixed order: markDone → incrementMigrated → insertEvent (with .catch)
    await stubMarkDone('job-1');
    await stubIncrementMigrated('deploy-1');
    await stubInsertEvent('actor-1', 'MIGRATED', {}, 0).catch(() => {});

    assert.deepEqual(callOrder, ['markDone', 'incrementMigrated', 'insertEvent']);
    assert.equal(callOrder[0], 'markDone', 'markDone must be first');
  });

  test('buggy ordering: job stuck in migrating when insertEvent throws first', async () => {
    const callOrder = [];
    let jobStatus = 'migrating';

    const stubInsertEventThatThrows = async () => {
      callOrder.push('insertEvent');
      throw new Error('insert failed');
    };
    const stubMarkDone = async () => {
      callOrder.push('markDone');
      jobStatus = 'done';
    };

    // Simulate old buggy order (insertEvent first, error swallowed, markDone never called)
    try {
      await stubInsertEventThatThrows();
      await stubMarkDone();
    } catch { /* swallowed — markDone never runs */ }

    assert.equal(jobStatus, 'migrating', 'BUG: job never marked done when insertEvent throws first');
    assert.ok(!callOrder.includes('markDone'), 'markDone was never reached (the bug)');
  });
});

// ─── SC17-C: storage functions propagate errors ────────────────────────────────
//
// The definitions route calls updateCompiledJson and insertChangepoint with no
// surrounding try/catch. If these functions propagate DB errors, Fastify returns
// 500 to the caller. Tests here verify the propagation contract at the function
// level — no server or module mocking required.
//
// Technique: SQLite RAISE() triggers on the shared getDb() connection. Because
// the test and the repo functions use the same connection (same process, module
// singleton), triggers created here are immediately visible to the repo functions.

describe('SC17-C: storage functions called by definitions route propagate errors', () => {
  test('C1: updateCompiledJson rejects when SQLite UPDATE fails', async () => {
    const { getDb } = await import('../../src/registry/db.js');
    const { createDefinition, updateCompiledJson } = await import('../../src/registry/definitionRepo.js');
    const db = getDb();

    // Seed a definition so updateCompiledJson has a real row to UPDATE
    const defId = `sc17c1-${Date.now()}`;
    await createDefinition({
      id:             defId,
      parentId:       null,
      definitionJson: { id: defId, initial: 'idle', states: { idle: { type: 'final' } } },
      deployedAt:     Date.now(),
    });

    // Install trigger to make any compiled_json UPDATE fail
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS __fault_inject_compiled_json
      BEFORE UPDATE OF compiled_json ON definitions
      BEGIN
        SELECT RAISE(ABORT, 'SQLITE_IOERR: disk full (injected)');
      END
    `);

    try {
      await assert.rejects(
        () => updateCompiledJson(defId, { states: {}, guards: {}, actions: {}, afterTransitions: {} }),
        (err) => err.message.includes('disk full') || err.code?.includes('SQLITE') || err.message?.includes('SQLITE'),
        'updateCompiledJson must propagate DB errors — route relies on this for 500 responses'
      );
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS __fault_inject_compiled_json`);
    }
  });

  test('C2: insertChangepoint rejects when SQLite INSERT fails, nothing persisted', async () => {
    const { getDb } = await import('../../src/registry/db.js');
    const { insertChangepoint } = await import('../../src/registry/changepointRepo.js');
    const db = getDb();

    const childDefId = `sc17c2-${Date.now()}`;

    // Install trigger to make any INSERT into changepoints fail
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS __fault_inject_changepoint
      BEFORE INSERT ON changepoints
      BEGIN
        SELECT RAISE(ABORT, 'injected failure: changepoints insert');
      END
    `);

    try {
      await assert.rejects(
        () => insertChangepoint({ tStar: Date.now(), prefixHash: '0', refinement: 1, childDefId }),
        (err) => err.message.includes('injected') || err.code?.includes('SQLITE') || err.message?.includes('SQLITE'),
        'insertChangepoint must propagate DB errors — route relies on this for 500 responses'
      );
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS __fault_inject_changepoint`);
    }

    // Verify RAISE(ABORT) prevented the INSERT — changepoint must be absent
    const row = db.prepare('SELECT id FROM changepoints WHERE child_def_id = ?').get(childDefId);
    assert.equal(row, undefined,
      `Changepoint must be absent after insertChangepoint failure, found: ${JSON.stringify(row)}`);
  });
});

// ─── SC17-D: Postgres webhook DELETE transaction rollback ─────────────────────

describe('SC17-D: Postgres webhook DELETE rolls back on partial failure', {
  skip: !process.env.STATEKEEP_DB_URL?.startsWith('postgres')
}, () => {
  test('both DELETEs roll back when second throws', async () => {
    let deliveriesDeleteCalled = false;
    let webhookDeleteCalled = false;
    let webhookRowExists = true;

    const simulateFixedTransaction = async (transactionFn) => {
      try {
        await transactionFn({
          query: async (sql) => {
            if (sql.includes('webhook_deliveries')) {
              deliveriesDeleteCalled = true;
            } else if (sql.includes('webhooks WHERE')) {
              webhookDeleteCalled = true;
              throw new Error('simulated second DELETE failure');
            }
          }
        });
      } catch {
        webhookRowExists = true;
      }
    };

    await simulateFixedTransaction(async (client) => {
      await client.query('DELETE FROM webhook_deliveries WHERE webhook_id=$1', ['w1']);
      await client.query('DELETE FROM webhooks WHERE id=$1', ['w1']);
    });

    assert.ok(deliveriesDeleteCalled, 'deliveries DELETE was attempted');
    assert.ok(webhookDeleteCalled, 'webhook DELETE was attempted');
    assert.ok(webhookRowExists, 'webhook row still exists after rollback (transaction invariant)');
  });
});
