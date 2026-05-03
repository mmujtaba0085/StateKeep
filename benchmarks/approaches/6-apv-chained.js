/**
 * benchmarks/approaches/6-apv-chained.js
 *
 * APPROACH: StateKeep APV engine — 3-phase chained migration.
 *
 * Demonstrates automatic multi-hop routing: Group A migrates v1→v2→v4
 * without any additional developer intervention after declaring the historyPath.
 *
 * Phase 1 — v1 → v2 (historyPath A, same as Approach 1):
 *   Group A migrates, Group C is stranded (needs_rescue).
 *
 * Phase 2 — rescue v3 (historyPath C, same as Approach 1):
 *   Group C rescued from v1 to v3.
 *
 * Phase 3 — chain v4 (historyPath A, parentId=v3):
 *   Group A actors (now on v2, fingerprint still includes PAY_FEE) automatically
 *   match v4's historyPath → migrate v2 → v4. Zero additional developer code.
 *   Group B (on v1) and Group C (on v3) do not match → stay put.
 *
 * Final: Group A on v4 ✓, Group B on v1 ✓, Group C on v3 ✓.
 * Accuracy: 100%. Developer cost: 0 lines.
 */

import {
  LOAN_V2, LOAN_V3, LOAN_V4,
  PAID_HISTORY_PATH, FAST_TRACK_HISTORY_PATH, RESCUE_STATE_MAPPING,
} from '../shared/scenarios.js';
import { waitForDeployment, verifyRouting, getActorDistribution } from '../shared/setup.js';

export const name          = '6-apv-chained';
export const description   = '6. APV Chained (v1→v2→v4, auto-hop, 0 dev lines)';
export const developerCode = 0;

export async function run(client, setup, config) {
  const v2Id = `loan-v2-chain-${setup.runId}`;
  const v3Id = `loan-v3-chain-${setup.runId}`;
  const v4Id = `loan-v4-chain-${setup.runId}`;

  // ── Phase 1: v1 → v2 (historyPath A, confirms stranded Group C) ──────────
  const p1Start = performance.now();

  let dep1 = await client.put('/v1/definitions', {
    id:          v2Id,
    parentId:    setup.v1Id,
    definition:  LOAN_V2,
    historyPath: PAID_HISTORY_PATH,
  }, setup.apiKey);

  if (dep1.status === 200 && dep1.body.status === 'requires_confirmation') {
    dep1 = await client.put('/v1/definitions', {
      id:           v2Id,
      parentId:     setup.v1Id,
      definition:   LOAN_V2,
      historyPath:  PAID_HISTORY_PATH,
      confirmToken: dep1.body.confirmToken,
    }, setup.apiKey);
  }
  if (dep1.status !== 201 && dep1.status !== 200) throw new Error(`Deploy v2 failed: ${dep1.status}`);

  const dep1Row = dep1.body.affectedActors > 0
    ? await waitForDeployment(client, setup.apiKey, v2Id, config.timeoutMs)
    : { status: 'complete', affected_actors: 0, migrated_count: 0, failed_count: 0 };

  const phase1Ms = Math.round(performance.now() - p1Start);

  // ── Phase 2: rescue Group C (historyPath C, stateMapping) ────────────────
  const p2Start = performance.now();

  const dep2 = await client.put('/v1/definitions', {
    id:           v3Id,
    parentId:     v2Id,
    definition:   LOAN_V3,
    historyPath:  FAST_TRACK_HISTORY_PATH,
    stateMapping: RESCUE_STATE_MAPPING,
  }, setup.apiKey);

  if (dep2.status !== 201 && dep2.status !== 200) throw new Error(`Deploy v3 failed: ${dep2.status}`);

  const dep2Row = dep2.body.affectedActors > 0
    ? await waitForDeployment(client, setup.apiKey, v3Id, config.timeoutMs)
    : { status: 'complete', affected_actors: 0, migrated_count: 0, failed_count: 0 };

  const phase2Ms = Math.round(performance.now() - p2Start);

  // ── Phase 3: chain v4 for Group A (v2 → v4 automatically) ────────────────
  // Group A actors are now on v2. Their historyFingerprint still includes the
  // PAY_FEE event. Deploying v4 with the same historyPath re-routes them:
  // APV computes that v4 is accessible for actors with the PAY_FEE fingerprint
  // → migration jobs created for v2 actors automatically.
  const p3Start = performance.now();

  const dep3 = await client.put('/v1/definitions', {
    id:          v4Id,
    parentId:    v3Id,
    definition:  LOAN_V4,
    historyPath: PAID_HISTORY_PATH,   // same path — Group A fingerprint matches
  }, setup.apiKey);

  if (dep3.status !== 201 && dep3.status !== 200) throw new Error(`Deploy v4 failed: ${dep3.status}`);

  process.stdout.write(` [v4 affectedActors=${dep3.body.affectedActors}]`);

  const dep3Row = dep3.body.affectedActors > 0
    ? await waitForDeployment(client, setup.apiKey, v4Id, config.timeoutMs)
    : { status: 'complete', affected_actors: 0, migrated_count: 0, failed_count: 0 };

  const phase3Ms = Math.round(performance.now() - p3Start);

  // ── Verify: A→v4, B→v1, C→v3 ─────────────────────────────────────────────
  const routing = await verifyRouting(client, setup.apiKey, setup, {
    A: v4Id,       // Group A chained all the way to v4
    B: setup.v1Id, // Group B still on v1 — never matched any historyPath
    C: v3Id,       // Group C rescued to v3
  });

  const dist = await getActorDistribution(client, setup.apiKey, setup.allActorIds, {
    [setup.v1Id]: 'v1 (original)',
    [v2Id]:       'v2 (intermediate)',
    [v3Id]:       'v3 (rescued)',
    [v4Id]:       'v4 (chained)',
  });

  return {
    approach: name, description, developerCode,
    phase1Ms, phase2Ms, phase3Ms, totalMs: phase1Ms + phase2Ms + phase3Ms,
    deployments: [
      { label: 'v2 (historyPath A)',  ...dep1Row },
      { label: 'v3 (rescue C)',       ...dep2Row },
      { label: 'v4 (chain A: v2→v4)', ...dep3Row },
    ],
    routing, dist,
    notes: [
      `Phase 1: ${dep1Row.migrated_count ?? 0} Group A migrated v1→v2; ${dep1.body.strandedTagged ?? 0} Group C stranded`,
      `Phase 2: ${dep2Row.migrated_count ?? 0} Group C rescued v1→v3`,
      `Phase 3: ${dep3Row.migrated_count ?? 0} Group A auto-chained v2→v4 (same historyPath, no extra code)`,
      'Group A traveled v1→v2→v4 automatically across 3 deployments',
      'Group B on v1 throughout — APV fingerprint never matched any historyPath',
    ],
  };
}
