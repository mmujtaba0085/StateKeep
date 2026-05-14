/**
 * benchmarks/approaches/12-parallel-states.js
 *
 * APPROACH: APV migration on XState parallel (orthogonal) state machines.
 *
 * Demonstrates that StateKeep's APV fingerprint system is agnostic to state
 * machine structure. Parallel states, compound state values, and independent
 * region transitions all work transparently — the fingerprint tracks event
 * names only, not state topology.
 *
 * Machine: CHECKOUT_V1 — parallel `active` state with two orthogonal regions:
 *   payment  (unpaid → paid)
 *   shipping (unselected → selected)
 *
 * Three actor groups (20 each):
 *   Group P — PAY event processed → state: {active: {payment:'paid', shipping:'unselected'}}
 *   Group S — SELECT_SHIPPING processed → state: {active: {payment:'unpaid', shipping:'selected'}}
 *   Group N — no events → state: {active: {payment:'unpaid', shipping:'unselected'}}
 *
 * Migration: deploy CHECKOUT_V2 with historyPath: ['PAY']
 *   → Group P fingerprint = FNV('PAY') — matches historyPath exactly → migrated ✓
 *   → Group S fingerprint = FNV('SELECT_SHIPPING') — different hash → stays ✓
 *   → Group N fingerprint = '0' (no events) — no match → stays ✓
 *
 * Expected accuracy: 100%. Developer cost: 0 lines.
 *
 * Also reports compound state values stored in the DB for each group,
 * demonstrating that StateKeep fully persists and restores parallel state objects.
 */

import { CHECKOUT_V1, CHECKOUT_V2, PAY_HISTORY_PATH } from '../shared/scenarios.js';
import { waitForDeployment } from '../shared/setup.js';

export const name          = '12-parallel-states';
export const description   = '12. Parallel XState states (APV fingerprint agnostic)';
export const developerCode = 0;

async function spawnAndDrive(client, apiKey, defId, orgId, count, events) {
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

export async function run(client, setup, config) {
  const runId = setup.runId;
  const apiKey = setup.apiKey;
  const perGroup = setup.perGroup;

  const v1Id = `checkout-v1-${runId}`;
  const v2Id = `checkout-v2-${runId}`;

  // Deploy parallel state machines (standalone, no parentId)
  const defV1 = await client.put('/v1/definitions', { id: v1Id, definition: CHECKOUT_V1 }, apiKey);
  if (defV1.status !== 201 && defV1.status !== 200) throw new Error(`Deploy checkout-v1 failed: ${defV1.status}`);

  // ── Spawn 3 groups on CHECKOUT_V1 ────────────────────────────────────────────
  const p1Start = performance.now();
  const [groupP, groupS, groupN] = await Promise.all([
    spawnAndDrive(client, apiKey, v1Id, setup.orgId, perGroup, ['PAY']),
    spawnAndDrive(client, apiKey, v1Id, setup.orgId, perGroup, ['SELECT_SHIPPING']),
    spawnAndDrive(client, apiKey, v1Id, setup.orgId, perGroup, []),   // no events
  ]);
  const setupMs = Math.round(performance.now() - p1Start);

  // Sample state values to show compound objects in the response
  const sampleP = perGroup > 0 ? await client.get(`/v1/actors/${groupP[0]}`, apiKey) : null;
  const sampleS = perGroup > 0 ? await client.get(`/v1/actors/${groupS[0]}`, apiKey) : null;
  const sampleN = perGroup > 0 ? await client.get(`/v1/actors/${groupN[0]}`, apiKey) : null;

  // ── Deploy CHECKOUT_V2 with historyPath=['PAY'] ───────────────────────────────
  // Only Group P (fingerprint = FNV('PAY')) should migrate.
  const p2Start = performance.now();
  const dep2 = await client.put('/v1/definitions', {
    id: v2Id, parentId: v1Id, definition: CHECKOUT_V2, historyPath: PAY_HISTORY_PATH,
  }, apiKey);
  if (dep2.status !== 201 && dep2.status !== 200) throw new Error(`Deploy checkout-v2 failed: ${dep2.status}`);

  const dep2Row = dep2.body.affectedActors > 0
    ? await waitForDeployment(client, apiKey, v2Id, config.timeoutMs)
    : { status: 'complete', affected_actors: 0, migrated_count: 0, failed_count: 0 };
  const phase2Ms = Math.round(performance.now() - p2Start);

  // ── Verify routing ────────────────────────────────────────────────────────────
  const allIds = [...groupP, ...groupS, ...groupN];
  let correct = 0, wrong = 0;
  const wrongActors = [];

  const expected = new Map([
    ...groupP.map(id => [id, v2Id]),       // Group P → v2 (paid, should migrate)
    ...groupS.map(id => [id, v1Id]),       // Group S → v1 (shipping only, stays)
    ...groupN.map(id => [id, v1Id]),       // Group N → v1 (no events, stays)
  ]);

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
        if (wrongActors.length < 10) wrongActors.push({ id: actor.id, expected: exp, actual: actor.definitionId });
      }
    }
    if (res.body.actors.length < 500) break;
  }

  const accuracy = allIds.length > 0 ? Math.round((correct / allIds.length) * 100) : 0;

  // Clean up checkout actors (separate from the standard loan actors in setup)
  await Promise.allSettled(allIds.map(id => client.delete(`/v1/actors/${id}`, apiKey)));

  return {
    approach: name, description, developerCode,
    phase1Ms: setupMs, phase2Ms, totalMs: setupMs + phase2Ms,
    routing: { correct, wrong, accuracy, wrongActors },
    dist: { byCounts: {}, defLabels: {}, needsRescue: 0 },
    notes: [
      `CHECKOUT_V1: parallel machine with payment + shipping orthogonal regions`,
      `Group P state (after PAY):              ${JSON.stringify(sampleP?.body?.stateValue ?? '?')}`,
      `Group S state (after SELECT_SHIPPING):  ${JSON.stringify(sampleS?.body?.stateValue ?? '?')}`,
      `Group N state (no events):              ${JSON.stringify(sampleN?.body?.stateValue ?? '?')}`,
      `historyPath=['PAY'] → affectedActors=${dep2.body.affectedActors} (Group P only)`,
      `${dep2Row.migrated_count ?? 0} Group P actors migrated to v2 (VERIFY_PAYMENT step added)`,
      'APV fingerprint is event-name based — parallel regions and compound state values are invisible to it',
    ],
  };
}
