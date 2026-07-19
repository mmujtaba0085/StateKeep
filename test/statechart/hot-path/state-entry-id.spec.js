import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { getDb } from '../../../src/registry/db.js';
import { createActor, findActorById, updateActorState } from '../../../src/registry/actorRepo.js';

const defId = randomUUID();

// Bootstrap a definition so foreign key constraint is satisfied
await (async () => {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO definitions (id, machine_id, org_id, definition_json, deployed_at, status, created_at)
     VALUES (?, ?, 'default', '{}', 0, 'active', 0)`
  ).run(defId, defId);
})();

test('createActor stores stateEntryId', async () => {
  const id = randomUUID();
  await createActor({
    id, definitionId: defId, orgId: 'default',
    stateValue: 'idle', context: {}, logicalStartTick: 0,
    historyFingerprint: '0', stateEntryId: 7,
  });
  const actor = await findActorById(id);
  assert.equal(actor.stateEntryId, 7);
});

test('updateActorState persists stateEntryId', async () => {
  const id = randomUUID();
  await createActor({
    id, definitionId: defId, orgId: 'default',
    stateValue: 'idle', context: {}, logicalStartTick: 0,
    historyFingerprint: '0', stateEntryId: 0,
  });
  await updateActorState(id, {
    stateValue: 'review', context: {}, historyFingerprint: '0',
    regionFingerprints: null, lastEventTick: null,
    status: 'active', stateEntryId: 12345,
  });
  const actor = await findActorById(id);
  assert.equal(actor.stateEntryId, 12345);
});
