/**
 * benchmarks/approaches/9-missing-context.js
 *
 * FAILURE MODE: actors spawned before the context.group field policy was introduced.
 *
 * Real-world scenario: your system has been running for months. You add a
 * context.group tagging policy to help with future migrations. But all actors
 * spawned BEFORE the policy have context_json = NULL or {} — no group field.
 *
 * Simulated here by nullifying context_json for half of Group A actors after
 * setup. The context-based routing (approach 3) reads context.group and finds
 * nothing — silently skips them. No error is raised.
 *
 * Expected accuracy: ~83% (10 of 20 Group A actors have no context field).
 *
 * APV immunity: historyFingerprint is independent of context. Actors that
 * processed PAY_FEE carry FNV(START·SUBMIT_INFO·PAY_FEE) regardless of
 * whether context was ever set. APV routes them correctly.
 *
 * REQUIRES: STATEKEEP_DB_PATH + STATEKEEP_ENCRYPTION_KEY.
 */

import Database             from 'better-sqlite3';
import { createDecipheriv } from 'crypto';
import { LOAN_V2, LOAN_V3 } from '../shared/scenarios.js';
import { verifyRouting, getActorDistribution } from '../shared/setup.js';

export const name          = '9-missing-context';
export const description   = '9. Missing context field (approach 3 breaks, APV immune)';
export const developerCode = 30;
export const requiresDb    = true;

function decryptContext(blob, encKeyHex) {
  if (!blob) return {};
  try {
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    if (!encKeyHex) return JSON.parse(buf.toString('utf8'));
    const key = Buffer.from(encKeyHex, 'hex');
    const iv  = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const enc = buf.slice(28);
    const d   = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'));
  } catch { return {}; }
}

export async function run(client, setup, config) {
  if (!config.dbPath) {
    return { approach: name, description, developerCode, skipped: true,
      skipReason: 'STATEKEEP_DB_PATH not set' };
  }

  const v2Id = `loan-v2-noctx-${setup.runId}`;
  const v3Id = `loan-v3-noctx-${setup.runId}`;

  for (const [id, def] of [[v2Id, LOAN_V2], [v3Id, LOAN_V3]]) {
    const r = await client.put('/v1/definitions', { id, definition: def }, setup.apiKey);
    if (r.status !== 201 && r.status !== 200) throw new Error(`Deploy ${id} failed: ${r.status}`);
  }

  const db = new Database(config.dbPath, { readonly: false });

  // ── Step 1: nullify context for half of Group A ───────────────────────────────
  // Simulates actors that predate the context.group tagging policy.
  const groupARows = db.prepare(
    `SELECT id, context_json FROM actors WHERE definition_id = ? AND org_id = ? AND status = 'active'`
  ).all(setup.v1Id, setup.orgId).filter(row => {
    const ctx = decryptContext(row.context_json, config.encryptionKey);
    return ctx.group === 'A';
  });

  const nullifyCount = Math.floor(groupARows.length / 2);
  const nullifyStmt  = db.prepare('UPDATE actors SET context_json = NULL WHERE id = ?');
  for (let i = 0; i < nullifyCount; i++) {
    nullifyStmt.run(groupARows[i].id);
  }

  // ── Step 2: context-based routing (identical to approach 3) ──────────────────
  const rows = db.prepare(
    `SELECT id, context_json FROM actors WHERE definition_id = ? AND org_id = ? AND status = 'active'`
  ).all(setup.v1Id, setup.orgId);

  const groupA = [], groupC = [];
  for (const row of rows) {
    const ctx = decryptContext(row.context_json, config.encryptionKey);
    if (ctx.group === 'A') groupA.push(row.id);
    if (ctx.group === 'C') groupC.push(row.id);
  }

  const p1Start = performance.now();
  if (groupA.length > 0) {
    const stmt = db.prepare('UPDATE actors SET definition_id = ? WHERE id = ?');
    db.transaction(ids => { for (const id of ids) stmt.run(v2Id, id); })(groupA);
  }
  const phase1Ms = Math.round(performance.now() - p1Start);

  const p2Start = performance.now();
  if (groupC.length > 0) {
    const stmt = db.prepare(`UPDATE actors SET definition_id = ?, state_value = '"rescued"', status = 'active' WHERE id = ?`);
    db.transaction(ids => { for (const id of ids) stmt.run(v3Id, id); })(groupC);
  }
  db.close();
  const phase2Ms = Math.round(performance.now() - p2Start);

  const routing = await verifyRouting(client, setup.apiKey, setup, {
    A: v2Id, B: setup.v1Id, C: v3Id,
  });

  const dist = await getActorDistribution(client, setup.apiKey, setup.allActorIds, {
    [setup.v1Id]: 'v1 (original / no-context stuck)',
    [v2Id]:       'v2 (paid path)',
    [v3Id]:       'v3 (rescued)',
  });

  return {
    approach: name, description, developerCode,
    phase1Ms, phase2Ms, totalMs: phase1Ms + phase2Ms,
    routing, dist,
    accuracyNote: true,
    notes: [
      `Nullified context_json for ${nullifyCount} of ${groupARows.length} Group A actors (legacy actors)`,
      `Context routing found only ${groupA.length} Group A actors — ${nullifyCount} had no group field`,
      `${nullifyCount} actors permanently stuck on v1 — context routing has no fallback`,
      'APV immune: fingerprint encodes PAY_FEE event path regardless of context field presence',
    ],
    risks: [
      'Silent failure: no warning when context.group is missing — actors are simply skipped',
      'Production systems accumulate legacy actors over time, growing this failure category',
      'Cannot distinguish "Group B" from "pre-policy Group A" by context scan alone',
    ],
  };
}
