/**
 * benchmarks/approaches/10-chain-deep.js
 *
 * APPROACH: APV 4-hop chained migration (v1 → v2 → v4 → v6).
 *
 * Extends Approach 6 by adding a fourth version. Group A actors automatically
 * follow three consecutive deployments that share PAID_HISTORY_PATH, ending on v6.
 * Zero developer code required for any of the three forward hops.
 *
 * Phase 1 — v1→v2 (historyPath A, same PAY_FEE path):
 *   Group A migrates. Group C stranded (needs_rescue).
 *
 * Phase 2 — rescue v3 (historyPath C + stateMapping):
 *   Group C rescued from v1 to v3.
 *
 * Phase 3 — v2→v4 (historyPath A, second hop):
 *   Group A actors on v2 auto-chain to v4 (same fingerprint, logicalTime = T1+1).
 *
 * Phase 4 — v4→v6 (historyPath A, third hop):
 *   Group A actors on v4 auto-chain to v6 (logicalTime = T3+1 skips v4 changepoint).
 *
 * Final: Group A on v6 ✓, Group B on v1 ✓, Group C on v3 ✓.
 * Accuracy: 100%. Developer cost: 0 lines across all 4 hops.
 */

import {
  LOAN_V2, LOAN_V3, LOAN_V4, LOAN_V6,
  PAID_HISTORY_PATH, FAST_TRACK_HISTORY_PATH, RESCUE_STATE_MAPPING,
} from '../shared/scenarios.js';
import { waitForDeployment, verifyRouting, getActorDistribution } from '../shared/setup.js';

export const name          = '10-chain-deep';
export const description   = '10. APV Deep Chain (v1→v2→v4→v6, 4 hops, 0 dev lines)';
export const developerCode = 0;

export async function run(client, setup, config) {
  const v2Id = `loan-v2-deep-${setup.runId}`;
  const v3Id = `loan-v3-deep-${setup.runId}`;
  const v4Id = `loan-v4-deep-${setup.runId}`;
  const v6Id = `loan-v6-deep-${setup.runId}`;

  // ── Phase 1: v1 → v2 ────────────────────────────────────────────────────────
  const p1Start = performance.now();
  let dep1 = await client.put('/v1/definitions', {
    id: v2Id, parentId: setup.v1Id, definition: LOAN_V2, historyPath: PAID_HISTORY_PATH,
  }, setup.apiKey);

  if (dep1.status === 200 && dep1.body.status === 'requires_confirmation') {
    dep1 = await client.put('/v1/definitions', {
      id: v2Id, parentId: setup.v1Id, definition: LOAN_V2,
      historyPath: PAID_HISTORY_PATH, confirmToken: dep1.body.confirmToken,
    }, setup.apiKey);
  }
  if (dep1.status !== 201 && dep1.status !== 200) throw new Error(`Deploy v2 failed: ${dep1.status}`);

  const dep1Row = dep1.body.affectedActors > 0
    ? await waitForDeployment(client, setup.apiKey, v2Id, config.timeoutMs)
    : { status: 'complete', affected_actors: 0, migrated_count: 0, failed_count: 0 };
  const phase1Ms = Math.round(performance.now() - p1Start);

  // ── Phase 2: rescue Group C → v3 ─────────────────────────────────────────────
  const p2Start = performance.now();
  const dep2 = await client.put('/v1/definitions', {
    id: v3Id, parentId: v2Id, definition: LOAN_V3,
    historyPath: FAST_TRACK_HISTORY_PATH, stateMapping: RESCUE_STATE_MAPPING,
  }, setup.apiKey);
  if (dep2.status !== 201 && dep2.status !== 200) throw new Error(`Deploy v3 failed: ${dep2.status}`);

  const dep2Row = dep2.body.affectedActors > 0
    ? await waitForDeployment(client, setup.apiKey, v3Id, config.timeoutMs)
    : { status: 'complete', affected_actors: 0, migrated_count: 0, failed_count: 0 };
  const phase2Ms = Math.round(performance.now() - p2Start);

  // ── Phase 3: v2 → v4 (second hop for Group A) ────────────────────────────────
  const p3Start = performance.now();
  const dep3 = await client.put('/v1/definitions', {
    id: v4Id, parentId: v3Id, definition: LOAN_V4, historyPath: PAID_HISTORY_PATH,
  }, setup.apiKey);
  if (dep3.status !== 201 && dep3.status !== 200) throw new Error(`Deploy v4 failed: ${dep3.status}`);
  process.stdout.write(` [v4 affectedActors=${dep3.body.affectedActors}]`);

  const dep3Row = dep3.body.affectedActors > 0
    ? await waitForDeployment(client, setup.apiKey, v4Id, config.timeoutMs)
    : { status: 'complete', affected_actors: 0, migrated_count: 0, failed_count: 0 };
  const phase3Ms = Math.round(performance.now() - p3Start);

  // ── Phase 4: v4 → v6 (third hop for Group A) ─────────────────────────────────
  const p4Start = performance.now();
  const dep4 = await client.put('/v1/definitions', {
    id: v6Id, parentId: v4Id, definition: LOAN_V6, historyPath: PAID_HISTORY_PATH,
  }, setup.apiKey);
  if (dep4.status !== 201 && dep4.status !== 200) throw new Error(`Deploy v6 failed: ${dep4.status}`);
  process.stdout.write(` [v6 affectedActors=${dep4.body.affectedActors}]`);

  const dep4Row = dep4.body.affectedActors > 0
    ? await waitForDeployment(client, setup.apiKey, v6Id, config.timeoutMs)
    : { status: 'complete', affected_actors: 0, migrated_count: 0, failed_count: 0 };
  const phase4Ms = Math.round(performance.now() - p4Start);

  const routing = await verifyRouting(client, setup.apiKey, setup, {
    A: v6Id, B: setup.v1Id, C: v3Id,
  });

  const dist = await getActorDistribution(client, setup.apiKey, setup.allActorIds, {
    [setup.v1Id]: 'v1 (original)',
    [v2Id]:       'v2 (hop 1)',
    [v3Id]:       'v3 (rescued)',
    [v4Id]:       'v4 (hop 2)',
    [v6Id]:       'v6 (final)',
  });

  return {
    approach: name, description, developerCode,
    phase1Ms, phase2Ms, phase3Ms, phase4Ms,
    totalMs: phase1Ms + phase2Ms + phase3Ms + phase4Ms,
    deployments: [
      { label: 'v2 (hop 1: v1→v2)', ...dep1Row },
      { label: 'v3 (rescue C)',      ...dep2Row },
      { label: 'v4 (hop 2: v2→v4)', ...dep3Row },
      { label: 'v6 (hop 3: v4→v6)', ...dep4Row },
    ],
    routing, dist,
    notes: [
      `Hop 1: ${dep1Row.migrated_count ?? 0} Group A migrated v1→v2`,
      `Hop 2: ${dep2Row.migrated_count ?? 0} Group C rescued v1→v3`,
      `Hop 3: ${dep3Row.migrated_count ?? 0} Group A auto-chained v2→v4 (logicalTime = T1+1)`,
      `Hop 4: ${dep4Row.migrated_count ?? 0} Group A auto-chained v4→v6 (logicalTime = T3+1)`,
      'Group A traveled v1→v2→v4→v6 across 3 hops with zero migration code',
      'Group B on v1 throughout — fingerprint never matched PAID_HISTORY_PATH',
    ],
  };
}
