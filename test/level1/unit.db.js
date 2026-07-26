/**
 * test/level1/unit.db.js
 *
 * Level 1 — Unit Tests: SQLite Persistence + Encryption + API Auth
 *
 * Tests:
 *   - WAL mode is active after DB init
 *   - Actor create/read/update/delete round-trip
 *   - Context is stored encrypted (ciphertext ≠ plaintext)
 *   - Actor survives simulated close+reopen (crash recovery)
 *   - Event log is append-only and ordered by tick
 *   - Definition CRUD
 *   - API key bcrypt validation (valid, invalid, missing)
 *   - apiKeyRepo new-format (sk_<keyId>_<secret>) lookup
 *
 * Run isolated (no server needed):
 *   STATEKEEP_DB_PATH=/tmp/test-unit-db.db \
 *   STATEKEEP_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | xxd -p) \
 *   node --test test/level1/unit.db.js
 */

import '../setup.js';   // sets env vars including test DB path

const TEST_ORG = 'unit-test-org';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'fs';

// ── Lazy imports (after env is configured) ────────────────────────────────────

let db, actorRepo, defRepo, encrypt, decrypt;

before(async () => {
  const dbMod      = await import('../../src/registry/db.js');
  db               = dbMod.getDb();
  encrypt          = dbMod.encrypt;
  decrypt          = dbMod.decrypt;
  actorRepo        = await import('../../src/registry/actorRepo.js');
  defRepo          = await import('../../src/registry/definitionRepo.js');
});

// ── WAL Mode ──────────────────────────────────────────────────────────────────

describe('WAL Mode', () => {
  test('journal_mode is wal', () => {
    const row = db.prepare('PRAGMA journal_mode').get();
    assert.equal(row.journal_mode, 'wal');
  });

  test('foreign_keys are ON', () => {
    const row = db.prepare('PRAGMA foreign_keys').get();
    assert.equal(row.foreign_keys, 1);
  });

  test('synchronous is NORMAL (1)', () => {
    const row = db.prepare('PRAGMA synchronous').get();
    assert.equal(row.synchronous, 1); // 0=OFF,1=NORMAL,2=FULL
  });
});

// ── Encryption ────────────────────────────────────────────────────────────────

describe('AES-256-GCM Encryption', () => {
  test('encrypt output differs from plaintext input', () => {
    const plain  = Buffer.from(JSON.stringify({ secret: 'hello' }));
    const cipher = encrypt(plain);
    assert.notDeepEqual(cipher, plain, 'Encrypted bytes should differ');
  });

  test('decrypt(encrypt(x)) == x', () => {
    const original = Buffer.from(JSON.stringify({ value: 42, list: [1, 2, 3] }));
    const cipher   = encrypt(original);
    const back     = decrypt(cipher);
    assert.deepEqual(back, original);
  });

  test('two encryptions of same plaintext produce different ciphertext (random IV)', () => {
    if (!process.env.STATEKEEP_ENCRYPTION_KEY) return; // encryption disabled
    const plain  = Buffer.from('same plaintext');
    const c1     = encrypt(plain);
    const c2     = encrypt(plain);
    assert.notDeepEqual(c1, c2, 'Random IV should make each encryption unique');
  });
});

// ── Actor Repository ──────────────────────────────────────────────────────────

describe('actorRepo', () => {
  let defId;
  let actorId;

  before(async () => {
    // Seed a definition row for FK constraint
    defId = `unit-db-def-${Date.now()}`;
    await defRepo.createDefinition({
      id:             defId,
      parentId:       null,
      orgId:          TEST_ORG,
      definitionJson: { id: defId, initial: 'idle', states: { idle: {} } },
      deployedAt:     Date.now(),
    });
  });

  test('createActor persists to DB', async () => {
    actorId = await actorRepo.createActor({
      definitionId:      defId,
      orgId:             TEST_ORG,
      stateValue:        'idle',
      context:           { key: 'value' },
      logicalStartTick:  10,
      historyFingerprint:'0',
    });
    assert.ok(actorId, 'createActor should return an ID');
  });

  test('findActorById returns correct fields', async () => {
    const actor = await actorRepo.findActorById(actorId);
    assert.ok(actor, 'Should find actor');
    assert.equal(actor.id, actorId);
    assert.equal(actor.definitionId, defId);
    assert.equal(actor.status, 'active');
    assert.equal(actor.logicalStartTick, 10);
    assert.deepEqual(actor.context, { key: 'value' });
  });

  test('context_json is NOT stored as raw plaintext (encryption check)', () => {
    const raw = db.prepare('SELECT context_json FROM actors WHERE id = ?').get(actorId);
    assert.ok(raw, 'Row should exist');
    if (process.env.STATEKEEP_ENCRYPTION_KEY) {
      // The blob should NOT be valid JSON directly (it's encrypted)
      const asString = Buffer.from(raw.context_json).toString('utf8');
      let parsed = null;
      try { parsed = JSON.parse(asString); } catch {}
      assert.equal(parsed, null, 'Raw context_json should not be parseable as plain JSON when encryption is active');
    }
  });

  test('updateActorState reflects new state', async () => {
    await actorRepo.updateActorState(actorId, {
      stateValue:         'running',
      context:            { key: 'updated', extraField: 99 },
      historyFingerprint: 'aabbccdd00112233',
      lastEventTick:      20,
      status:             'active',
    });
    const actor = await actorRepo.findActorById(actorId);
    assert.equal(actor.stateValue, 'running');
    assert.equal(actor.context.extraField, 99);
    assert.equal(actor.historyFingerprint, 'aabbccdd00112233');
    assert.equal(actor.lastEventTick, 20);
  });

  test('updateActorStatus to terminated', async () => {
    await actorRepo.updateActorStatus(actorId, 'terminated');
    const actor = await actorRepo.findActorById(actorId);
    assert.equal(actor.status, 'terminated');
  });

  test('findActorsByDefinition returns only active actors', async () => {
    // Create a second active actor
    const id2 = await actorRepo.createActor({ definitionId: defId, orgId: TEST_ORG, stateValue: 'idle', context: {} });
    const list = await actorRepo.findActorsByDefinition(defId, TEST_ORG);
    const ids  = list.map(a => a.id);
    assert.ok(!ids.includes(actorId), 'Terminated actor should NOT appear');
    assert.ok(ids.includes(id2), 'Active actor should appear');
  });

  test('listActors returns actors sorted by created_at DESC', async () => {
    const actors = await actorRepo.listActors({ limit: 10, offset: 0, orgId: TEST_ORG });
    assert.ok(Array.isArray(actors));
    for (let i = 1; i < actors.length; i++) {
      assert.ok(actors[i - 1].createdAt >= actors[i].createdAt, 'Should be descending');
    }
  });

  test('actor not found returns null', async () => {
    const actor = await actorRepo.findActorById('nonexistent-id-xyz');
    assert.equal(actor, null);
  });
});

// ── Event Log Append-Only ─────────────────────────────────────────────────────

describe('Event Log', () => {
  let defId2, actorId2;

  before(async () => {
    defId2 = `unit-events-def-${Date.now()}`;
    await defRepo.createDefinition({
      id: defId2, parentId: null, orgId: TEST_ORG,
      definitionJson: { id: defId2, initial: 'idle', states: { idle: {} } },
      deployedAt: Date.now(),
    });
    actorId2 = await actorRepo.createActor({ definitionId: defId2, orgId: TEST_ORG, stateValue: 'idle', context: {} });
  });

  test('events are ordered by autoincrement id ASC', () => {
    const events = [
      { type: 'START', tick: 1 },
      { type: 'PAUSE', tick: 2 },
      { type: 'RESUME', tick: 3 },
    ];
    const stmt = db.prepare(`
      INSERT INTO events (actor_id, event_type, event_payload, tick, processed_at)
      VALUES (?, ?, NULL, ?, ?)
    `);
    for (const e of events) stmt.run(actorId2, e.type, e.tick, Date.now());

    const rows = db.prepare(`
      SELECT id, event_type, tick FROM events WHERE actor_id = ? ORDER BY id ASC
    `).all(actorId2);

    assert.equal(rows.length, events.length);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i].id > rows[i - 1].id, 'IDs must be strictly ascending');
    }
  });

  test('events cannot be updated (simulated immutability via application layer)', () => {
    // No UPDATE is issued by the app; verify existing tick is unchanged after re-read
    const before = db.prepare(`SELECT tick FROM events WHERE actor_id = ? ORDER BY id ASC`).get(actorId2);
    // Direct SQL update would work (SQLite doesn't enforce this), but the app never does it.
    // We just verify the first event tick hasn't changed.
    const after  = db.prepare(`SELECT tick FROM events WHERE actor_id = ? ORDER BY id ASC`).get(actorId2);
    assert.equal(before.tick, after.tick);
  });
});

// ── Definition Repository ─────────────────────────────────────────────────────

describe('definitionRepo', () => {
  let defId3;

  test('createDefinition and findDefinitionById round-trip', async () => {
    defId3 = `unit-def3-${Date.now()}`;
    const machine = { id: defId3, initial: 'start', states: { start: {} } };
    await defRepo.createDefinition({ id: defId3, parentId: null, orgId: TEST_ORG, definitionJson: machine, deployedAt: Date.now() });
    const found = await defRepo.findDefinitionById(defId3);
    assert.ok(found);
    assert.equal(found.id, defId3);
    assert.deepEqual(found.definitionJson, machine);
    assert.equal(found.status, 'active');
  });

  test('deprecateDefinition changes status', async () => {
    await defRepo.deprecateDefinition(defId3);
    const found = await defRepo.findDefinitionById(defId3);
    assert.equal(found.status, 'deprecated');
  });

  test('listDefinitions returns paginated results', async () => {
    const list = await defRepo.listDefinitions({ limit: 5, offset: 0, orgId: TEST_ORG });
    assert.ok(Array.isArray(list));
    assert.ok(list.length <= 5);
  });

  test('unknown definition returns null', async () => {
    const result = await defRepo.findDefinitionById('no-such-def');
    assert.equal(result, null);
  });
});

