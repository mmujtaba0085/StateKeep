/**
 * benchmarks/approaches/2-full-table-update.js
 *
 * APPROACH: Naive SQL — direct full-table UPDATE, no history filtering.
 *
 * Phase 1: Deploy v2 standalone, UPDATE every actor from v1 to v2.
 *   Moves Group A (20, correct), Group B (20, WRONG — same state), Group C (20, WRONG — wrong state in v2).
 *
 * Phase 2: Deploy v3 standalone, UPDATE actors in fast_track state to v3.
 *   Group C was moved to v2 in Phase 1 (still in fast_track state), now moved to v3 with state update.
 *   NOTE: state_value is stored JSON-encoded ('"fast_track"'), so the WHERE clause must match exactly.
 *
 * Final: Group A on v2 ✓, Group B on v2 ❌ (should be v1), Group C on v3 ✓
 * Accuracy: 67% (40/60 correct).
 * Developer cost: ~10 lines.
 *
 * REQUIRES: STATEKEEP_DB_PATH.
 */

import Database from 'better-sqlite3';
import { LOAN_V2, LOAN_V3 } from '../shared/scenarios.js';
import { verifyRouting, getActorDistribution } from '../shared/setup.js';

export const name          = '2-full-table-update';
export const description   = '2. Full-table SQL (no filtering, ~10 dev lines)';
export const developerCode = 10;
export const requiresDb    = true;

export async function run(client, setup, config) {
  if (!config.dbPath) {
    return { approach: name, description, developerCode, skipped: true,
      skipReason: 'STATEKEEP_DB_PATH not set' };
  }

  const v2Id = `loan-v2-naive-${setup.runId}`;
  const v3Id = `loan-v3-naive-${setup.runId}`;

  // Deploy both versions standalone (no parentId = no API migration triggered)
  for (const [id, def] of [[v2Id, LOAN_V2], [v3Id, LOAN_V3]]) {
    const r = await client.put('/v1/definitions', { id, definition: def }, setup.apiKey);
    if (r.status !== 201 && r.status !== 200) throw new Error(`Deploy ${id} failed: ${r.status}`);
  }

  // ── Phase 1: move ALL v1 actors to v2 (no filtering) ─────────────────────
  const p1Start = performance.now();
  const db = new Database(config.dbPath, { readonly: false });

  // Blanket UPDATE — Group A, B, C all moved. Group C ends up in v2 with fast_track state.
  const { changes: p1Changes } = db.prepare(
    'UPDATE actors SET definition_id = ? WHERE definition_id = ? AND org_id = ?'
  ).run(v2Id, setup.v1Id, setup.orgId);

  const phase1Ms = Math.round(performance.now() - p1Start);

  // ── Phase 2: move fast_track actors from v2 to v3 (state-based rescue) ───
  const p2Start = performance.now();

  // Developer knows fast_track was removed, so they update fast_track actors to v3
  // and manually remap the state (StateKeep stateMapping is bypassed).
  const { changes: p2Changes } = db.prepare(
    `UPDATE actors SET definition_id = ?, state_value = '"rescued"'
     WHERE definition_id = ? AND state_value = '"fast_track"' AND org_id = ?`
  ).run(v3Id, v2Id, setup.orgId);

  db.close();
  const phase2Ms = Math.round(performance.now() - p2Start);

  const routing = await verifyRouting(client, setup.apiKey, setup, {
    A: v2Id, B: setup.v1Id, C: v3Id,
  });

  const dist = await getActorDistribution(client, setup.apiKey, setup.allActorIds, {
    [setup.v1Id]: 'v1 (original)',
    [v2Id]:       'v2 (paid path)',
    [v3Id]:       'v3 (rescued)',
  });

  return {
    approach: name, description, developerCode,
    phase1Ms, phase2Ms, totalMs: phase1Ms + phase2Ms,
    routing, dist,
    notes: [
      `Phase 1: blanket UPDATE moved ${p1Changes} actors (A+B+C) from v1 → v2`,
      `Phase 2: state-based UPDATE moved ${p2Changes} fast_track actors → v3`,
      'Group B (waived fee) wrongly migrated to v2 — same state as Group A, indistinguishable',
    ],
    risks: [
      'Cannot distinguish Group A from Group B by state alone',
      'Group C moved to v2 with incompatible state — in-memory hot registry may serve stale data',
      'Direct DB writes bypass event log and audit trail',
    ],
  };
}
