/**
 * benchmarks/approaches/11-stress.js
 *
 * APPROACH: APV Engine at high actor count (throughput stress test).
 *
 * Runs the standard APV 2-phase migration (same as Approach 1) but against a
 * large actor population controlled by STRESS_ACTOR_COUNT (default 300).
 *
 * Measures:
 *   - Setup time: spawn + event-drive N actors
 *   - Migration throughput: jobs/sec for the migrate-worker batch loop
 *   - Accuracy: must remain 100% regardless of count
 *
 * Set STRESS_ACTOR_COUNT=3000 (divisible by 3) to run a heavier stress pass.
 * The migrate-worker processes in batches of 100 at 20 concurrent. Expect
 * roughly linear scaling until DB I/O or WSL DrvFs becomes the bottleneck.
 */

import {
  LOAN_V2, LOAN_V3,
  PAID_HISTORY_PATH, FAST_TRACK_HISTORY_PATH, RESCUE_STATE_MAPPING,
} from '../shared/scenarios.js';
import { setupScenario, waitForDeployment, verifyRouting, getActorDistribution, cleanup } from '../shared/setup.js';

export const name          = '11-stress';
export const description   = '11. APV Stress (high actor count, 0 dev lines)';
export const developerCode = 0;

export async function run(client, setup, config) {
  // Use STRESS_ACTOR_COUNT if set, otherwise 3× the current perGroup (same as main run)
  const rawCount   = parseInt(process.env.STRESS_ACTOR_COUNT ?? String(setup.perGroup * 3 * 5), 10);
  const stressCount = Math.floor(Math.max(rawCount, 6) / 3) * 3;
  const perGroup    = stressCount / 3;

  process.stdout.write(` [stress=${stressCount} actors, cleaning setup actors first]`);

  // Clean the standard setup actors so the stress run is isolated
  await cleanup(client, setup.apiKey, setup.allActorIds);

  // Fresh stress setup
  process.stdout.write(' [spawning]');
  const stressSetup = await setupScenario(client, { ...config, actorCount: stressCount });

  const v2Id = `loan-v2-stress-${stressSetup.runId}`;
  const v3Id = `loan-v3-stress-${stressSetup.runId}`;

  // ── Phase 1: v1 → v2 (historyPath A) ─────────────────────────────────────────
  const p1Start = performance.now();
  let dep1 = await client.put('/v1/definitions', {
    id: v2Id, parentId: stressSetup.v1Id, definition: LOAN_V2, historyPath: PAID_HISTORY_PATH,
  }, stressSetup.apiKey);

  if (dep1.status === 200 && dep1.body.status === 'requires_confirmation') {
    dep1 = await client.put('/v1/definitions', {
      id: v2Id, parentId: stressSetup.v1Id, definition: LOAN_V2,
      historyPath: PAID_HISTORY_PATH, confirmToken: dep1.body.confirmToken,
    }, stressSetup.apiKey);
  }
  if (dep1.status !== 201 && dep1.status !== 200) throw new Error(`Deploy v2 failed: ${dep1.status}`);
  process.stdout.write(` [v2 affected=${dep1.body.affectedActors}]`);

  const dep1Row = dep1.body.affectedActors > 0
    ? await waitForDeployment(client, stressSetup.apiKey, v2Id, config.timeoutMs)
    : { status: 'complete', affected_actors: 0, migrated_count: 0, failed_count: 0 };
  const phase1Ms = Math.round(performance.now() - p1Start);

  // ── Phase 2: rescue Group C → v3 ─────────────────────────────────────────────
  const p2Start = performance.now();
  const dep2 = await client.put('/v1/definitions', {
    id: v3Id, parentId: v2Id, definition: LOAN_V3,
    historyPath: FAST_TRACK_HISTORY_PATH, stateMapping: RESCUE_STATE_MAPPING,
  }, stressSetup.apiKey);
  if (dep2.status !== 201 && dep2.status !== 200) throw new Error(`Deploy v3 failed: ${dep2.status}`);

  const dep2Row = dep2.body.affectedActors > 0
    ? await waitForDeployment(client, stressSetup.apiKey, v3Id, config.timeoutMs)
    : { status: 'complete', affected_actors: 0, migrated_count: 0, failed_count: 0 };
  const phase2Ms = Math.round(performance.now() - p2Start);

  const totalMigrated = (dep1Row.migrated_count ?? 0) + (dep2Row.migrated_count ?? 0);
  const totalMs       = phase1Ms + phase2Ms;
  const throughput    = totalMs > 0 ? Math.round((totalMigrated / totalMs) * 1000) : 0;

  // Override setup with stressSetup for routing verification
  const stressSetupForVerify = {
    ...stressSetup,
    // verifyRouting expects groupA/B/C + allActorIds on the setup object
  };

  const routing = await verifyRouting(client, stressSetup.apiKey, stressSetupForVerify, {
    A: v2Id, B: stressSetup.v1Id, C: v3Id,
  });

  const dist = await getActorDistribution(client, stressSetup.apiKey, stressSetup.allActorIds, {
    [stressSetup.v1Id]: 'v1 (original)',
    [v2Id]:             'v2 (paid path)',
    [v3Id]:             'v3 (rescued)',
  });

  // Clean stress actors (run-all.js will try to clean setup.allActorIds which were already cleaned)
  await cleanup(client, stressSetup.apiKey, stressSetup.allActorIds);

  return {
    approach: name, description, developerCode,
    phase1Ms, phase2Ms, totalMs,
    routing, dist,
    notes: [
      `Stress count: ${stressCount} actors (${perGroup} per group)`,
      `Phase 1: ${dep1Row.migrated_count ?? 0} Group A migrated in ${phase1Ms}ms`,
      `Phase 2: ${dep2Row.migrated_count ?? 0} Group C rescued in ${phase2Ms}ms`,
      `Total throughput: ${throughput} actors/sec (${totalMigrated} migrations in ${totalMs}ms)`,
      `Worker batch size: 100, concurrency: 20 — set STRESS_ACTOR_COUNT env var to scale further`,
    ],
  };
}
