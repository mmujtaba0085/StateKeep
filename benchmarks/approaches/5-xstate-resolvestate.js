/**
 * benchmarks/approaches/5-xstate-resolvestate.js
 *
 * APPROACH: XState resolveState per actor — 2 phases.
 *
 * Phase 1: Run resolveState on v2 for every actor.
 *   Group A (awaiting_docs): resolves ✓ — but so does Group B (same state). No routing signal.
 *   Group C (fast_track):    resolves ✗ — state removed in v2. Developer knows to skip.
 *   Developer migrates all that resolved (A + B) → v2. Group B is wrongly migrated.
 *
 * Phase 2: Developer spots that fast_track actors are incompatible with v2.
 *   Runs resolveState on v3 for Group C. v3 lacks fast_track too (mapped to 'rescued').
 *   resolveState fails again → developer falls back to manual state update SQL.
 *
 * resolveState gives a partial signal for incompatibility (Group C) but cannot
 * distinguish compatible groups (A vs B) — both succeed because state is identical.
 *
 * Accuracy: 67% (A ✓, B ✗, C ✓). Developer cost: ~20 lines.
 *
 * REQUIRES: STATEKEEP_DB_PATH.
 */

import Database          from 'better-sqlite3';
import { createMachine } from 'xstate';
import { LOAN_V2, LOAN_V3 } from '../shared/scenarios.js';
import { verifyRouting, getActorDistribution } from '../shared/setup.js';

export const name          = '5-xstate-resolvestate';
export const description   = '5. XState resolveState (partial signal, ~20 dev lines)';
export const developerCode = 20;
export const requiresDb    = true;

export async function run(client, setup, config) {
  if (!config.dbPath) {
    return { approach: name, description, developerCode, skipped: true,
      skipReason: 'STATEKEEP_DB_PATH not set' };
  }

  const v2Id    = `loan-v2-resolve-${setup.runId}`;
  const v3Id    = `loan-v3-resolve-${setup.runId}`;
  const v2Machine = createMachine(LOAN_V2);
  const v3Machine = createMachine(LOAN_V3);

  for (const [id, def] of [[v2Id, LOAN_V2], [v3Id, LOAN_V3]]) {
    const r = await client.put('/v1/definitions', { id, definition: def }, setup.apiKey);
    if (r.status !== 201 && r.status !== 200) throw new Error(`Deploy ${id} failed: ${r.status}`);
  }

  // ── Fetch all actors once ─────────────────────────────────────────────────
  const actorPages = [];
  let offset = 0;
  while (true) {
    const res = await client.get(`/v1/actors?limit=500&offset=${offset}`, setup.apiKey);
    if (res.status !== 200 || !res.body.actors?.length) break;
    actorPages.push(...res.body.actors);
    if (res.body.actors.length < 500) break;
    offset += 500;
  }

  const allActorIdSet = new Set(setup.allActorIds);
  const v1Actors = actorPages.filter(a => allActorIdSet.has(a.id) && a.definitionId === setup.v1Id);

  // ── Phase 1: resolveState on v2 for all v1 actors ─────────────────────────
  const p1Start = performance.now();
  const toMigrateV2 = [], incompatible = [];

  for (const actor of v1Actors) {
    try {
      v2Machine.resolveState({ value: actor.stateValue ?? 'idle', context: actor.context ?? {} });
      toMigrateV2.push(actor.id);   // resolved → developer assumes "migrate"
    } catch {
      incompatible.push(actor);     // fast_track not in v2 → signal to skip
    }
  }

  // resolveState gives no way to distinguish A from B (both in awaiting_docs → both resolve).
  // Developer migrates all resolved actors (A + B — Group B is wrongly included).
  const db = new Database(config.dbPath, { readonly: false });
  if (toMigrateV2.length > 0) {
    const stmt = db.prepare('UPDATE actors SET definition_id = ? WHERE id = ?');
    db.transaction(ids => { for (const id of ids) stmt.run(v2Id, id); })(toMigrateV2);
  }
  const phase1Ms = Math.round(performance.now() - p1Start);

  // ── Phase 2: rescue incompatible actors (Group C) via manual SQL ─────────
  // resolveState on v3 also fails for fast_track (v3 has 'rescued', not 'fast_track').
  // Developer falls back to SQL with manual stateMapping knowledge.
  const p2Start = performance.now();

  let resolved3 = 0, failed3 = 0;
  const toRescue = [];
  for (const actor of incompatible) {
    try {
      v3Machine.resolveState({ value: actor.stateValue ?? 'idle', context: actor.context ?? {} });
      resolved3++;
    } catch {
      failed3++;
      toRescue.push(actor.id);  // still incompatible → apply stateMapping manually
    }
  }

  if (toRescue.length > 0) {
    const stmt = db.prepare(`UPDATE actors SET definition_id = ?, state_value = '"rescued"', status = 'active' WHERE id = ?`);
    db.transaction(ids => { for (const id of ids) stmt.run(v3Id, id); })(toRescue);
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
      `Phase 1: resolveState(v2) → ${toMigrateV2.length} resolved (A+B), ${incompatible.length} incompatible (C)`,
      `Phase 2: resolveState(v3) → ${resolved3} resolved, ${failed3} still incompatible → rescued via SQL`,
      'resolveState correctly signals incompatibility (Group C) but cannot distinguish A from B',
      `Group B (${setup.groupB.length} actors) wrongly migrated — resolveState gives false confidence`,
    ],
    risks: [
      'resolveState success does not imply migration is correct — only that state name exists',
      'Cannot distinguish groups whose actors share the same state (awaiting_docs)',
      'Adds XState as a migration-script dependency',
      'Direct DB UPDATE bypasses event log and audit trail',
    ],
  };
}
