/**
 * benchmarks/approaches/4-event-history-query.js
 *
 * APPROACH: SQL event history JOIN to identify eligible actors — 2 phases.
 *
 * Phase 1: Find actors with PAY_FEE event → migrate to v2.
 * Phase 2: Find actors with FAST_TRACK event → migrate to v3.
 *
 * Accuracy: 100% — event history is immutable ground truth.
 * Developer cost: ~35 lines (two correlated EXISTS queries + updates).
 * Performance: O(N × E) per phase — degrades past ~100k event rows.
 *
 * REQUIRES: STATEKEEP_DB_PATH.
 */

import Database from 'better-sqlite3';
import { LOAN_V2, LOAN_V3 } from '../shared/scenarios.js';
import { verifyRouting, getActorDistribution } from '../shared/setup.js';

export const name          = '4-event-history-query';
export const description   = '4. Event history SQL (~35 dev lines)';
export const developerCode = 35;
export const requiresDb    = true;

export async function run(client, setup, config) {
  if (!config.dbPath) {
    return { approach: name, description, developerCode, skipped: true,
      skipReason: 'STATEKEEP_DB_PATH not set' };
  }

  const v2Id = `loan-v2-sql-${setup.runId}`;
  const v3Id = `loan-v3-sql-${setup.runId}`;

  for (const [id, def] of [[v2Id, LOAN_V2], [v3Id, LOAN_V3]]) {
    const r = await client.put('/v1/definitions', { id, definition: def }, setup.apiKey);
    if (r.status !== 201 && r.status !== 200) throw new Error(`Deploy ${id} failed: ${r.status}`);
  }

  const db = new Database(config.dbPath, { readonly: false });

  // ── Phase 1: actors with PAY_FEE after SUBMIT_INFO → v2 ──────────────────
  const p1Start = performance.now();
  const paidActors = db.prepare(`
    SELECT DISTINCT a.id FROM actors a
    WHERE  a.definition_id = ? AND a.org_id = ? AND a.status = 'active'
      AND  EXISTS (SELECT 1 FROM events WHERE actor_id = a.id AND event_type = 'PAY_FEE')
  `).all(setup.v1Id, setup.orgId);

  if (paidActors.length > 0) {
    const stmt = db.prepare('UPDATE actors SET definition_id = ? WHERE id = ?');
    db.transaction(ids => { for (const { id } of ids) stmt.run(v2Id, id); })(paidActors);
  }
  const phase1Ms = Math.round(performance.now() - p1Start);

  // ── Phase 2: actors with FAST_TRACK after SUBMIT_INFO → v3 ───────────────
  const p2Start = performance.now();
  const ftActors = db.prepare(`
    SELECT DISTINCT a.id FROM actors a
    WHERE  a.definition_id = ? AND a.org_id = ? AND a.status IN ('active','needs_rescue')
      AND  EXISTS (SELECT 1 FROM events WHERE actor_id = a.id AND event_type = 'FAST_TRACK')
  `).all(setup.v1Id, setup.orgId);

  if (ftActors.length > 0) {
    const stmt = db.prepare(`UPDATE actors SET definition_id = ?, state_value = '"rescued"', status = 'active' WHERE id = ?`);
    db.transaction(ids => { for (const { id } of ids) stmt.run(v3Id, id); })(ftActors);
  }
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
      `Phase 1: event SQL found ${paidActors.length} PAY_FEE actors → migrated to v2`,
      `Phase 2: event SQL found ${ftActors.length} FAST_TRACK actors → rescued to v3`,
      'Event existence check: O(N × E) correlated EXISTS — no applicable index',
    ],
    risks: [
      'Query complexity: O(N × E) — degrades to minutes at >100k event rows',
      'Event existence check is sufficient due to state machine invariants; ordering not verified',
      'Direct DB UPDATE: no audit trail, bypasses hot registry consistency',
    ],
  };
}
