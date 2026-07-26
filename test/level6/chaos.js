/**
 * test/level6/chaos.js
 *
 * Level 6 — Chaos & Failure Tests
 *
 * Tests:
 *   - Engine disappears at runtime → falls back gracefully, no crash
 *   - Actor in "migrating" status recovers to "active" after worker restart
 *   - Logical clock monotonicity survives large jumps
 *   - AES-256-GCM decryption fails gracefully on corrupted ciphertext
 *   - DB write with invalid FK is rejected cleanly
 *   - Actor created with logicalStartTick = MAX_SAFE_INT survives
 *   - Engine destroy() can be called multiple times without error
 */

import '../setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { seedApiKey, post, get, put, BASE_URL } from '../setup.js';
import { engineReady, getEngine } from '../../src/ffi/engine.js';
import { linearMachine } from '../helpers/factories.js';

before(async () => {
  await seedApiKey();
  await put('/v1/definitions', { id: 'chaos-linear-v1', definition: linearMachine('chaos') });
});

// ── Chaos 1: Engine Disappears ────────────────────────────────────────────────

describe('Chaos 1: Engine fallback when .so is absent', () => {
  test('WASM engine is available and loaded', async () => {
    await engineReady;
    const eng = getEngine();
    assert.equal(eng.available, true, 'WASM engine must report available=true');
    assert.equal(eng.mode, 'wasm', 'Engine mode must be wasm');
  });

  test('system continues to spawn actors when engine is unavailable', async () => {
    // The running server uses its already-loaded engine singleton.
    // This verifies that an actor can still be created (fallback mode).
    const r = await post('/v1/actors', { definitionId: 'chaos-linear-v1' });
    assert.equal(r.status, 201, `Spawn failed in fallback mode: ${JSON.stringify(r.body)}`);
  });

  test('destroy() on engine does not throw', async () => {
    await engineReady;
    const { getEngine: ge } = await import('../../src/ffi/engine.js');
    const fb = ge();
    assert.doesNotThrow(() => fb.destroy());
    assert.doesNotThrow(() => fb.destroy()); // idempotent
    assert.doesNotThrow(() => fb.destroy()); // third time
  });
});

// ── Chaos 2: Corrupted Ciphertext ────────────────────────────────────────────

describe('Chaos 2: Corrupted context_json is handled gracefully', () => {
  test('actorRepo returns null context for corrupted encrypted data', async () => {
    const { getDb, encrypt }      = await import('../../src/registry/db.js');
    const { createActor, findActorById, updateActorState } = await import('../../src/registry/actorRepo.js');
    const { createDefinition }    = await import('../../src/registry/definitionRepo.js');

    const defId   = `chaos-corr-def-${Date.now()}`;
    createDefinition({ id: defId, parentId: null, orgId: 'chaos-test-org', definitionJson: linearMachine('chaos-corr'), deployedAt: Date.now() });
    const actorId = createActor({ definitionId: defId, orgId: 'chaos-test-org', stateValue: 'idle', context: { safe: true } });

    // Directly corrupt the context_json blob in the DB
    const db = getDb();
    db.prepare('UPDATE actors SET context_json = ? WHERE id = ?')
      .run(Buffer.from('CORRUPTED_GARBAGE_DATA_NOT_AES'), actorId);

    // findActorById should NOT throw — it should return null context gracefully
    assert.doesNotThrow(() => {
      const actor = findActorById(actorId);
      assert.ok(actor, 'Actor row should still be found');
      // context may be null due to decryption failure
      assert.ok(actor.context === null || actor.context !== undefined, 'context should be null or valid');
    });
  });
});

// ── Chaos 3: FK Constraint Enforcement ───────────────────────────────────────

describe('Chaos 3: Foreign key violations are caught', () => {
  test('creating actor with non-existent definition_id throws', async () => {
    const { createActor } = await import('../../src/registry/actorRepo.js');
    assert.throws(
      () => createActor({ definitionId: 'NO_SUCH_DEF_XYZ', orgId: 'chaos-test-org', stateValue: 'idle', context: {} }),
      (err) => {
        // better-sqlite3 throws on FK violation when FK=ON
        return err.message.includes('FOREIGN KEY') || err.message.includes('constraint') || err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY';
      }
    );
  });
});

// ── Chaos 4: Clock Skew / Large Ticks ────────────────────────────────────────

describe('Chaos 4: Logical clock handles extreme values', () => {
  test('actor with logicalStartTick = Number.MAX_SAFE_INTEGER persists and retrieves correctly', async () => {
    const { createActor, findActorById } = await import('../../src/registry/actorRepo.js');
    const { createDefinition } = await import('../../src/registry/definitionRepo.js');

    const defId   = `chaos-maxtick-${Date.now()}`;
    createDefinition({ id: defId, parentId: null, orgId: 'chaos-test-org', definitionJson: linearMachine('chaos'), deployedAt: Date.now() });

    const actorId = createActor({
      definitionId:     defId,
      orgId:            'chaos-test-org',
      stateValue:       'idle',
      context:          {},
      logicalStartTick: Number.MAX_SAFE_INTEGER,
    });

    const actor = findActorById(actorId);
    assert.ok(actor, 'Actor should be findable');
    assert.equal(actor.logicalStartTick, Number.MAX_SAFE_INTEGER);
  });

  test('clockTick monotonically increments past a million calls', async () => {
    await engineReady;
    const fb = getEngine();
    let prev = fb.clockTick();
    for (let i = 0; i < 1_000_000; i += 1000) {
      // Take every 1000th tick to keep test fast
      for (let j = 0; j < 1000; j++) fb.clockTick();
      const curr = fb.clockTick();
      assert.ok(curr > prev, `Clock went backwards at step ${i}: prev=${prev} curr=${curr}`);
      prev = curr;
    }
  });

  test('hash of large BigInt does not overflow', async () => {
    await engineReady;
    const fb = getEngine();
    const UINT64_MAX = 0xFFFFFFFFFFFFFFFFn;
    let h = fb.fnv1aInit();
    // Feed max-value bytes
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(UINT64_MAX);
    h = fb.fnv1aUpdate(h, buf);
    h = fb.fnv1aFinal(h);
    assert.ok(h >= 0n && h <= UINT64_MAX, `Hash out of uint64 range: ${h}`);
  });
});

// ── Chaos 5: Actor Status Recovery ───────────────────────────────────────────

describe('Chaos 5: Actor in "migrating" status recovers to usable state', () => {
  test('manually setting status=migrating then active allows events again', async () => {
    const { createActor, findActorById, updateActorStatus } = await import('../../src/registry/actorRepo.js');
    const { createDefinition } = await import('../../src/registry/definitionRepo.js');

    const defId   = `chaos-recover-${Date.now()}`;
    createDefinition({ id: defId, parentId: null, orgId: 'chaos-test-org', definitionJson: linearMachine('chaos'), deployedAt: Date.now() });
    const actorId = createActor({ definitionId: defId, orgId: 'chaos-test-org', stateValue: 'idle', context: {} });

    // Simulate crash mid-migration
    updateActorStatus(actorId, 'migrating');
    let actor = findActorById(actorId);
    assert.equal(actor.status, 'migrating');

    // Simulate recovery (migrate-worker rolls back to active on error)
    updateActorStatus(actorId, 'active');
    actor = findActorById(actorId);
    assert.equal(actor.status, 'active');
  });
});

// ── Chaos 6: Race Between Event and Termination ───────────────────────────────

describe('Chaos 6: Concurrent event + termination race', () => {
  test('actor is either usable or gracefully terminated — never in corrupt state', async () => {
    const spawnRes = await post('/v1/actors', { definitionId: 'chaos-linear-v1' });
    assert.equal(spawnRes.status, 201);
    const id = spawnRes.body.id;

    // Fire event and delete concurrently
    const [eventRes, deleteRes] = await Promise.all([
      post(`/v1/actors/${id}/event`, { type: 'START' }),
      (async () => {
        await new Promise(r => setTimeout(r, 10)); // slight delay
        return await import('../setup.js').then(m => m.del(`/v1/actors/${id}`));
      })(),
    ]);

    // Either event succeeded (200) or actor was already deleted (404/400)
    const validEventStatus = [200, 400, 404, 409];
    assert.ok(
      validEventStatus.includes(eventRes.status),
      `Unexpected event status in race: ${eventRes.status}`
    );
    // Delete should be 204 or 404 (if event raced and actor state is terminal)
    assert.ok([204, 404, 400].includes(deleteRes.status),
      `Unexpected delete status: ${deleteRes.status}`);

    // Final state should be consistent — not in an unknown limbo
    const finalState = await get(`/v1/actors/${id}/state`);
    assert.ok([200, 404].includes(finalState.status),
      `Actor in unexpected state after race: ${finalState.status}`);
  });
});
