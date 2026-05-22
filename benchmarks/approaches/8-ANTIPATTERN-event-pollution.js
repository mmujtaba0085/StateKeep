/**
 * benchmarks/approaches/8-event-pollution.js
 *
 * FAILURE MODE: events table polluted with injected rows.
 *
 * Real-world scenario: half of Group B actors have a fake PAY_FEE event row
 * inserted directly into the events table — simulating a replay bug, an ETL
 * import error, or an incident where events were recorded with wrong actor IDs.
 *
 * The event-history approach (approach 4) uses SQL EXISTS to find PAY_FEE events.
 * It finds the polluted Group B actors and wrongly migrates them to v2.
 *
 * Expected accuracy: ~83% (10 of 20 Group B wrongly migrated).
 *
 * APV immunity: historyFingerprint is computed by the actor worker at event-
 * processing time and stored in the actors table. Inserting rows directly into
 * the events table does NOT update the fingerprint column — so APV still reads
 * FNV(START·SUBMIT_INFO·WAIVE_FEE) for all Group B actors and correctly ignores
 * them. Accuracy would be 100% with APV.
 *
 * REQUIRES: STATEKEEP_DB_PATH.
 */

import Database from 'better-sqlite3';
import { LOAN_V2, LOAN_V3 } from '../shared/scenarios.js';
import { verifyRouting, getActorDistribution } from '../shared/setup.js';

export const name          = '8-event-pollution';
export const description   = '[ANTIPATTERN] 8. Event pollution (approach 4 breaks, APV immune)';
export const developerCode = 35;
export const requiresDb    = true;

export async function run(client, setup, config) {
  if (!config.dbPath) {
    return { approach: name, description, developerCode, skipped: true,
      skipReason: 'STATEKEEP_DB_PATH not set' };
  }

  const v2Id = `loan-v2-poll-${setup.runId}`;
  const v3Id = `loan-v3-poll-${setup.runId}`;

  for (const [id, def] of [[v2Id, LOAN_V2], [v3Id, LOAN_V3]]) {
    const r = await client.put('/v1/definitions', { id, definition: def }, setup.apiKey);
    if (r.status !== 201 && r.status !== 200) throw new Error(`Deploy ${id} failed: ${r.status}`);
  }

  const db = new Database(config.dbPath, { readonly: false });

  // ── Step 1: inject fake PAY_FEE events for half of Group B ──────────────────
  // Simulates an ETL import or event-replay bug that records events with wrong actor IDs.
  // The fingerprint column in the actors table is NOT updated — only the events table.
  const groupBRows = db.prepare(
    `SELECT a.id FROM actors a
     WHERE  a.definition_id = ? AND a.org_id = ? AND a.status = 'active'
       AND  NOT EXISTS (SELECT 1 FROM events WHERE actor_id = a.id AND event_type = 'PAY_FEE')`
  ).all(setup.v1Id, setup.orgId).filter((_, i) => i < Math.floor(setup.perGroup / 2));

  const pollutedCount = groupBRows.length;
  const injectStmt = db.prepare(`
    INSERT INTO events (actor_id, org_id, event_type, event_payload, tick, processed_at)
    VALUES (?, ?, 'PAY_FEE', '{}', 0, ?)
  `);
  for (const { id } of groupBRows) {
    injectStmt.run(id, setup.orgId, Date.now());
  }

  // ── Step 2: event-history routing (identical to approach 4) ─────────────────
  // EXISTS query finds PAY_FEE actors — includes polluted Group B actors.
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
    [v2Id]:       'v2 (paid path + polluted B)',
    [v3Id]:       'v3 (rescued)',
  });

  return {
    approach: name, description, developerCode,
    phase1Ms, phase2Ms, totalMs: phase1Ms + phase2Ms,
    routing, dist,
    notes: [
      `Injected ${pollutedCount} fake PAY_FEE rows into events table for Group B actors`,
      `EXISTS query found ${paidActors.length} PAY_FEE actors (${pollutedCount} were Group B — wrong)`,
      `${pollutedCount} Group B actors wrongly migrated to v2 (should stay on v1)`,
      'APV immune: fingerprint stored in actors table — events table injection has no effect on it',
    ],
    risks: [
      'Event existence check cannot distinguish real events from injected/replayed rows',
      'Any ETL import, replay, or cross-actor event error silently poisons migration targeting',
      'No way to retroactively clean up — every future event-based migration is also affected',
    ],
  };
}
