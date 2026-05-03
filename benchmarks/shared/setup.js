/**
 * benchmarks/shared/setup.js
 *
 * Common scenario setup for all benchmark approaches.
 * Creates a fresh isolated org with 60 actors (20 per group A/B/C).
 *
 * Group A: START → SUBMIT_INFO → PAY_FEE   → awaiting_docs  (migrates to v2)
 * Group B: START → SUBMIT_INFO → WAIVE_FEE → awaiting_docs  (stays on v1, same state as A)
 * Group C: START → SUBMIT_INFO → FAST_TRACK → fast_track    (stranded by v2, rescued to v3)
 */

import { randomBytes } from 'crypto';
import { LOAN_V1, GROUPS } from './scenarios.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function makeRunId() { return randomBytes(4).toString('hex'); }

async function spawnGroup(client, apiKey, definitionId, groupName, groupDef, count, batchSize, onProgress) {
  const ids = [];
  let spawned = 0;
  while (spawned < count) {
    const batch = Math.min(batchSize, count - spawned);
    const results = await Promise.all(
      Array.from({ length: batch }, () =>
        client.post('/v1/actors', {
          definitionId,
          initialContext: { group: groupName, paid: groupDef.paid, label: groupDef.label },
        }, apiKey)
      )
    );
    for (const res of results) {
      if (res.status === 201) ids.push(res.body.id);
    }
    spawned += batch;
    onProgress?.(ids.length);
  }
  return ids;
}

async function driveActor(client, apiKey, actorId, events) {
  for (const type of events) {
    const res = await client.post(`/v1/actors/${actorId}/event`, { type }, apiKey);
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`Event ${type} on ${actorId} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function setupScenario(client, config, { onProgress } = {}) {
  const runId = makeRunId();

  const orgRes = await client.post('/v1/orgs', { name: `bench-${runId}` }, config.apiKey, config.adminKey);
  if (orgRes.status !== 201) throw new Error(`Failed to create org: ${orgRes.status} ${JSON.stringify(orgRes.body)}`);
  const orgId = orgRes.body.id;

  const keyRes = await client.post(`/v1/orgs/${orgId}/keys`, { label: 'bench', tier: 'enterprise' }, config.apiKey, config.adminKey);
  if (keyRes.status !== 201) throw new Error(`Failed to create key: ${keyRes.status} ${JSON.stringify(keyRes.body)}`);
  const apiKey = keyRes.body.rawKey;

  const v1Id  = `loan-v1-${runId}`;
  const defRes = await client.put('/v1/definitions', { id: v1Id, definition: LOAN_V1 }, apiKey);
  if (defRes.status !== 201 && defRes.status !== 200) throw new Error(`Failed to deploy v1: ${defRes.status} ${JSON.stringify(defRes.body)}`);

  const perGroup      = Math.floor(config.actorCount / 3);
  const groupActorIds = { A: [], B: [], C: [] };
  let totalSpawned    = 0;

  for (const [groupName, groupDef] of Object.entries(GROUPS)) {
    const ids = await spawnGroup(
      client, apiKey, v1Id, groupName, groupDef, perGroup, config.batchSize,
      (n) => onProgress?.('spawn', totalSpawned + n, config.actorCount),
    );
    groupActorIds[groupName] = ids;
    totalSpawned += ids.length;
  }

  let driven = 0;
  for (const [groupName, ids] of Object.entries(groupActorIds)) {
    const events = GROUPS[groupName].events;
    for (let i = 0; i < ids.length; i += config.batchSize) {
      const batch = ids.slice(i, i + config.batchSize);
      await Promise.all(batch.map(id => driveActor(client, apiKey, id, events)));
      driven += batch.length;
      onProgress?.('drive', driven, totalSpawned);
    }
  }

  const allActorIds = [...groupActorIds.A, ...groupActorIds.B, ...groupActorIds.C];

  return {
    runId,
    orgId,
    apiKey,
    v1Id,
    groupA: groupActorIds.A,   // paid → awaiting_docs → should migrate to v2
    groupB: groupActorIds.B,   // waived → awaiting_docs → should stay on v1
    groupC: groupActorIds.C,   // fast-tracked → fast_track → stranded, rescued to v3
    allActorIds,
    perGroup,
  };
}

/**
 * Polls GET /v1/definitions/:defId/status until the latest deployment completes.
 */
export async function waitForDeployment(client, apiKey, defId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.get(`/v1/definitions/${defId}/status`, apiKey);
    if (res.status === 200) {
      const latest = (res.body.deployments ?? []).at(-1);
      if (!latest) { await sleep(300); continue; }
      if (latest.affected_actors === 0) return latest;
      if (latest.status === 'complete' || latest.status === 'failed') return latest;
      const processed = (latest.migrated_count ?? 0) + (latest.failed_count ?? 0);
      if (processed >= latest.affected_actors) return latest;
    }
    await sleep(300);
  }
  throw new Error(`Deployment timed out after ${timeoutMs}ms for ${defId}`);
}

// Keep legacy alias so any remaining callers don't break
export const waitForMigrationComplete = waitForDeployment;

/**
 * Fetches all actors in the org and returns a Map<actorId, {definitionId, status}>.
 */
async function fetchActorMap(client, apiKey, actorIdSet) {
  const map  = new Map();
  let offset = 0;
  while (true) {
    const res = await client.get(`/v1/actors?limit=500&offset=${offset}`, apiKey);
    if (res.status !== 200 || !res.body.actors?.length) break;
    for (const actor of res.body.actors) {
      if (actorIdSet.has(actor.id)) map.set(actor.id, { definitionId: actor.definitionId, status: actor.status });
    }
    if (res.body.actors.length < 500) break;
    offset += 500;
  }
  return map;
}

/**
 * Verifies routing by checking each actor's current definition against expectedDefs.
 *
 * @param expectedDefs  { A: defIdForGroupA, B: defIdForGroupB, C: defIdForGroupC }
 */
export async function verifyRouting(client, apiKey, setup, expectedDefs) {
  const allIds = new Set(setup.allActorIds);
  const actorMap = await fetchActorMap(client, apiKey, allIds);

  let correct = 0, wrong = 0;
  const wrongActors = [];

  const groups = [
    { name: 'A', ids: setup.groupA, label: GROUPS.A.label, expected: expectedDefs.A },
    { name: 'B', ids: setup.groupB, label: GROUPS.B.label, expected: expectedDefs.B },
    { name: 'C', ids: setup.groupC, label: GROUPS.C.label, expected: expectedDefs.C },
  ];

  for (const { name, ids, label, expected } of groups) {
    for (const actorId of ids) {
      const info = actorMap.get(actorId);
      const actual = info?.definitionId;
      if (actual === expected) {
        correct++;
      } else {
        wrong++;
        if (wrongActors.length < 50) {
          wrongActors.push({ actorId, group: name, label, expected, actual, status: info?.status });
        }
      }
    }
  }

  const total    = correct + wrong;
  const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
  return { correct, wrong, accuracy, wrongActors };
}

/**
 * Returns counts per definition + needs_rescue total.
 * defLabels: { [defId]: 'v1 (original)' } — labels for each definition.
 */
export async function getActorDistribution(client, apiKey, allActorIds, defLabels = {}) {
  const allIds   = new Set(allActorIds);
  const actorMap = await fetchActorMap(client, apiKey, allIds);

  const byCounts   = {};
  let needsRescue  = 0;

  for (const { definitionId, status } of actorMap.values()) {
    byCounts[definitionId] = (byCounts[definitionId] ?? 0) + 1;
    if (status === 'needs_rescue') needsRescue++;
  }

  return { byCounts, needsRescue, defLabels };
}

export async function cleanup(client, apiKey, actorIds, batchSize = 50) {
  for (let i = 0; i < actorIds.length; i += batchSize) {
    const batch = actorIds.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(id => client.delete(`/v1/actors/${id}`, apiKey)));
  }
}
