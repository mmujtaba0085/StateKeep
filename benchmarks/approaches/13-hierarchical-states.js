/**
 * benchmarks/approaches/13-hierarchical-states.js
 *
 * APPROACH: APV migration on XState hierarchical (compound) state machines.
 *
 * Demonstrates that:
 *   1. APV fingerprinting is topology-agnostic — events arrive flat regardless
 *      of machine nesting depth, so historyPath works identically.
 *   2. resolveLandingState (Tier 1 fix) correctly passes the full compound
 *      state value object to XState's resolveState(), preserving sub-state
 *      position after migration.
 *
 * Machine: CHECKOUT_HIER_V1 — compound `processing` state with nested sub-states:
 *   idle → processing (compound)
 *     processing.pending  (initial nested state)
 *     processing.review   (after REVIEW event)
 *     processing.approved (after APPROVE event)
 *   → done (final)
 *
 * Three actor groups (perGroup each):
 *   Group D — SUBMIT + REVIEW processed → state: {processing:'review'}
 *   Group S — SUBMIT only             → state: {processing:'pending'}
 *   Group N — no events               → state: 'idle'
 *
 * Migration: deploy CHECKOUT_HIER_V2 with historyPath: ['SUBMIT', 'REVIEW']
 *   → Group D fingerprint = FNV('SUBMIT' → 'REVIEW') — matches exactly → migrated ✓
 *   → Group S fingerprint = FNV('SUBMIT')             — different hash  → stays   ✓
 *   → Group N fingerprint = '0' (no events)           — no match        → stays   ✓
 *
 * Verification also checks that migrated actors have compound stateValue
 * correctly restored to {processing: 'review'} (sub-state preserved).
 *
 * Expected accuracy: 100%. Developer cost: 0 lines.
 */

import { waitForDeployment } from '../shared/setup.js';

export const name          = '13-hierarchical-states';
export const description   = '13. Hierarchical (compound) XState states (Tier 1 fix)';
export const developerCode = 0;

// ── Machine definitions ───────────────────────────────────────────────────────

const CHECKOUT_HIER_V1 = {
  id:      'checkout-hier',
  initial: 'idle',
  states: {
    idle: { on: { SUBMIT: 'processing' } },
    processing: {
      initial: 'pending',
      states: {
        pending:  { on: { REVIEW:  'review'   } },
        review:   { on: { APPROVE: 'approved' } },
        approved: { type: 'final' },
      },
    },
    done: { type: 'final' },
  },
};

const CHECKOUT_HIER_V2 = {
  id:      'checkout-hier',
  initial: 'idle',
  states: {
    idle: { on: { SUBMIT: 'processing' } },
    processing: {
      initial: 'pending',
      states: {
        pending:  { on: { REVIEW:       'review'         } },
        review:   { on: { APPROVE:      'approved',
                          DEEP_VERIFY:  'deep_verify'    } },   // new transition added
        deep_verify: { on: { VERIFIED:  'approved'       } },   // new nested state
        approved:    { type: 'final' },
      },
    },
    done: { type: 'final' },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function spawnAndDrive(client, apiKey, defId, count, events) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const res = await client.post('/v1/actors', { definitionId: defId, initialContext: {} }, apiKey);
    if (res.status === 201) ids.push(res.body.id);
  }
  await Promise.all(ids.map(async id => {
    for (const type of events) {
      await client.post(`/v1/actors/${id}/event`, { type }, apiKey);
    }
  }));
  return ids;
}

// ── Run ───────────────────────────────────────────────────────────────────────

export async function run(client, setup, config) {
  const { runId, apiKey, perGroup } = setup;

  const v1Id = `checkout-hier-v1-${runId}`;
  const v2Id = `checkout-hier-v2-${runId}`;

  // Deploy compound machine V1
  const defV1 = await client.put('/v1/definitions', { id: v1Id, definition: CHECKOUT_HIER_V1 }, apiKey);
  if (defV1.status !== 201 && defV1.status !== 200) throw new Error(`Deploy v1 failed: ${defV1.status}`);

  // Spawn 3 groups with different event histories
  const p1Start = performance.now();
  const [groupD, groupS, groupN] = await Promise.all([
    spawnAndDrive(client, apiKey, v1Id, perGroup, ['SUBMIT', 'REVIEW']),
    spawnAndDrive(client, apiKey, v1Id, perGroup, ['SUBMIT']),
    spawnAndDrive(client, apiKey, v1Id, perGroup, []),
  ]);
  const setupMs = Math.round(performance.now() - p1Start);

  // Sample compound state values for verification notes
  const sampleD = perGroup > 0 ? await client.get(`/v1/actors/${groupD[0]}`, apiKey) : null;
  const sampleS = perGroup > 0 ? await client.get(`/v1/actors/${groupS[0]}`, apiKey) : null;
  const sampleN = perGroup > 0 ? await client.get(`/v1/actors/${groupN[0]}`, apiKey) : null;

  // Deploy V2 targeting only Group D via historyPath
  const p2Start = performance.now();
  const dep2 = await client.put('/v1/definitions', {
    id: v2Id, parentId: v1Id, definition: CHECKOUT_HIER_V2,
    historyPath: ['SUBMIT', 'REVIEW'],
  }, apiKey);
  if (dep2.status !== 201 && dep2.status !== 200) throw new Error(`Deploy v2 failed: ${dep2.status}`);

  const dep2Row = dep2.body.affectedActors > 0
    ? await waitForDeployment(client, apiKey, v2Id, config.timeoutMs)
    : { status: 'complete', affected_actors: 0, migrated_count: 0, failed_count: 0 };
  const phase2Ms = Math.round(performance.now() - p2Start);

  // Verify routing accuracy
  const allIds = [...groupD, ...groupS, ...groupN];
  const expected = new Map([
    ...groupD.map(id => [id, v2Id]),
    ...groupS.map(id => [id, v1Id]),
    ...groupN.map(id => [id, v1Id]),
  ]);

  let correct = 0, wrong = 0;
  const wrongActors = [];

  for (let offset = 0; offset < allIds.length; offset += 500) {
    const res = await client.get(`/v1/actors?limit=500&offset=${offset}`, apiKey);
    if (res.status !== 200) break;
    for (const actor of (res.body.actors ?? [])) {
      const exp = expected.get(actor.id);
      if (exp === undefined) continue;
      if (actor.definitionId === exp) {
        correct++;
      } else {
        wrong++;
        if (wrongActors.length < 10)
          wrongActors.push({ id: actor.id, expected: exp, actual: actor.definitionId });
      }
    }
    if (res.body.actors.length < 500) break;
  }

  // Verify that a migrated Group D actor has compound state preserved
  let stateRestoreOk = null;
  if (groupD.length > 0) {
    const migratedActor = await client.get(`/v1/actors/${groupD[0]}`, apiKey);
    if (migratedActor.status === 200) {
      const sv = migratedActor.body.stateValue;
      // After migration the actor should still be in processing.review
      stateRestoreOk = sv && typeof sv === 'object' && sv.processing === 'review';
    }
  }

  const accuracy = allIds.length > 0 ? Math.round((correct / allIds.length) * 100) : 0;

  // Cleanup
  await Promise.allSettled(allIds.map(id => client.delete(`/v1/actors/${id}`, apiKey)));

  return {
    approach: name, description, developerCode,
    phase1Ms: setupMs, phase2Ms, totalMs: setupMs + phase2Ms,
    routing: { correct, wrong, accuracy, wrongActors },
    dist: { byCounts: {}, defLabels: {}, needsRescue: 0 },
    notes: [
      `CHECKOUT_HIER_V1: compound 'processing' state with pending→review→approved sub-states`,
      `Group D state (SUBMIT+REVIEW): ${JSON.stringify(sampleD?.body?.stateValue ?? '?')}`,
      `Group S state (SUBMIT only):   ${JSON.stringify(sampleS?.body?.stateValue ?? '?')}`,
      `Group N state (no events):     ${JSON.stringify(sampleN?.body?.stateValue ?? '?')}`,
      `historyPath=['SUBMIT','REVIEW'] → affectedActors=${dep2.body.affectedActors} (Group D only)`,
      `${dep2Row.migrated_count ?? 0} Group D actors migrated to v2 (deep_verify step added)`,
      `Compound sub-state preserved after migration: ${stateRestoreOk === null ? 'N/A' : stateRestoreOk ? 'YES ✓' : 'NO ✗'}`,
      'Tier 1 fix: resolveLandingState passes full compound {processing:"review"} to XState resolveState',
    ],
  };
}
