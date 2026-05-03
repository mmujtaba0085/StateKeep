/**
 * benchmarks/approaches/1-apv-engine.js
 *
 * APPROACH: StateKeep native historyPath migration (APV engine) — 2 phases.
 *
 * Phase 1 — v1 → v2 (historyPath A):
 *   Deploy v2 with historyPath=['START','SUBMIT_INFO','PAY_FEE'].
 *   Only Group A (paid fee) matches → migrates. Group B stays on v1.
 *   Group C (fast_track) is removed by v2 → stranded → needs_rescue.
 *
 * Phase 2 — rescue (historyPath C):
 *   Deploy v3 with historyPath=['START','SUBMIT_INFO','FAST_TRACK'] + stateMapping.
 *   Group C (needs_rescue on v1) matches → rescued to v3 in 'rescued' state.
 *
 * Developer cost: 0 lines of migration logic.
 * Accuracy:       100% — APV fingerprinting is exact.
 */

import {
  LOAN_V2, LOAN_V3,
  PAID_HISTORY_PATH, FAST_TRACK_HISTORY_PATH, RESCUE_STATE_MAPPING,
} from '../shared/scenarios.js';
import { waitForDeployment, verifyRouting, getActorDistribution } from '../shared/setup.js';

export const name        = '1-apv-engine';
export const description = '1. APV Engine (2-phase: historyPath + rescue)';
export const developerCode = 0;

export async function run(client, setup, config) {
  const v2Id = `loan-v2-apv-${setup.runId}`;
  const v3Id = `loan-v3-apv-${setup.runId}`;

  // ── Phase 1: deploy v2 with historyPath A ──────────────────────────────────
  const p1Start = performance.now();

  let dep1 = await client.put('/v1/definitions', {
    id:          v2Id,
    parentId:    setup.v1Id,
    definition:  LOAN_V2,
    historyPath: PAID_HISTORY_PATH,
  }, setup.apiKey);

  // v2 removes fast_track → server returns requires_confirmation for Group C
  if (dep1.status === 200 && dep1.body.status === 'requires_confirmation') {
    dep1 = await client.put('/v1/definitions', {
      id:           v2Id,
      parentId:     setup.v1Id,
      definition:   LOAN_V2,
      historyPath:  PAID_HISTORY_PATH,
      confirmToken: dep1.body.confirmToken,
    }, setup.apiKey);
  }
  if (dep1.status !== 201 && dep1.status !== 200) {
    throw new Error(`Deploy v2 failed: ${dep1.status} ${JSON.stringify(dep1.body)}`);
  }

  const dep1Row = dep1.body.affectedActors > 0
    ? await waitForDeployment(client, setup.apiKey, v2Id, config.timeoutMs)
    : { status: 'complete', affected_actors: 0, migrated_count: 0, failed_count: 0 };

  const phase1Ms = Math.round(performance.now() - p1Start);

  // ── Phase 2: rescue v3 for Group C ────────────────────────────────────────
  const p2Start = performance.now();

  const dep2 = await client.put('/v1/definitions', {
    id:           v3Id,
    parentId:     v2Id,
    definition:   LOAN_V3,
    historyPath:  FAST_TRACK_HISTORY_PATH,
    stateMapping: RESCUE_STATE_MAPPING,
  }, setup.apiKey);

  if (dep2.status !== 201 && dep2.status !== 200) {
    throw new Error(`Deploy v3 (rescue) failed: ${dep2.status} ${JSON.stringify(dep2.body)}`);
  }

  const dep2Row = dep2.body.affectedActors > 0
    ? await waitForDeployment(client, setup.apiKey, v3Id, config.timeoutMs)
    : { status: 'complete', affected_actors: 0, migrated_count: 0, failed_count: 0 };

  const phase2Ms = Math.round(performance.now() - p2Start);

  // ── Verify + distribution ─────────────────────────────────────────────────
  const routing = await verifyRouting(client, setup.apiKey, setup, {
    A: v2Id,
    B: setup.v1Id,
    C: v3Id,
  });

  const dist = await getActorDistribution(client, setup.apiKey, setup.allActorIds, {
    [setup.v1Id]: 'v1 (original)',
    [v2Id]:       'v2 (paid path)',
    [v3Id]:       'v3 (rescued)',
  });

  return {
    approach: name, description, developerCode,
    phase1Ms, phase2Ms, totalMs: phase1Ms + phase2Ms,
    deployments: [
      { label: 'v2 (historyPath A)', ...dep1Row },
      { label: 'v3 (rescue C)',      ...dep2Row },
    ],
    routing, dist,
    notes: [
      `Phase 1: historyPath ${JSON.stringify(PAID_HISTORY_PATH)} → ${dep1Row.migrated_count ?? 0} migrated to v2`,
      `Phase 1: ${dep1.body.strandedTagged ?? 0} Group C actors tagged needs_rescue`,
      `Phase 2: historyPath ${JSON.stringify(FAST_TRACK_HISTORY_PATH)} → ${dep2Row.migrated_count ?? 0} rescued to v3`,
      `stateMapping: ${JSON.stringify(RESCUE_STATE_MAPPING)} — fast_track lands in 'rescued'`,
    ],
  };
}
