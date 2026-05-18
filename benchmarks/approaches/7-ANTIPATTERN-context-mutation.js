/**
 * benchmarks/approaches/7-context-mutation.js
 *
 * FAILURE MODE: context.group silently mutated after spawn.
 *
 * Real-world scenario: half of Group A actors had their context.group field
 * overwritten to 'B' by a subsequent business event or admin operation.
 * The context-routing approach reads the CURRENT context and silently
 * misroutes those actors — no error, no warning.
 *
 * Phase 1: Corrupt 10 of 20 Group A actors (context.group 'A' → 'B').
 * Phase 2: Run context-based routing (same logic as approach 3).
 *   → 10 mutated actors look like Group B → not migrated → WRONG (expected v2)
 *   → 10 clean actors: correctly migrated to v2
 *   → Accuracy: ~83%
 *
 * APV immunity: historyFingerprint is a deterministic hash of events processed
 * through the actor worker. Mutating context_json has zero effect on it.
 * APV would route 100% correctly on the same corrupted dataset.
 *
 * REQUIRES: STATEKEEP_DB_PATH + STATEKEEP_ENCRYPTION_KEY.
 */

import Database                         from 'better-sqlite3';
import { createDecipheriv, createCipheriv, randomBytes } from 'crypto';
import { LOAN_V2, LOAN_V3 }             from '../shared/scenarios.js';
import { verifyRouting, getActorDistribution } from '../shared/setup.js';

export const name          = '7-context-mutation';
export const description   = '7. Context mutation (approach 3 breaks, APV immune)';
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

function encryptContext(obj, encKeyHex) {
  const plain = JSON.stringify(obj);
  if (!encKeyHex) return Buffer.from(plain);
  const key = Buffer.from(encKeyHex, 'hex');
  const iv  = randomBytes(12);
  const c   = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

export async function run(client, setup, config) {
  if (!config.dbPath) {
    return { approach: name, description, developerCode, skipped: true,
      skipReason: 'STATEKEEP_DB_PATH not set' };
  }

  const v2Id = `loan-v2-mut-${setup.runId}`;
  const v3Id = `loan-v3-mut-${setup.runId}`;

  for (const [id, def] of [[v2Id, LOAN_V2], [v3Id, LOAN_V3]]) {
    const r = await client.put('/v1/definitions', { id, definition: def }, setup.apiKey);
    if (r.status !== 201 && r.status !== 200) throw new Error(`Deploy ${id} failed: ${r.status}`);
  }

  const db = new Database(config.dbPath, { readonly: false });

  // ── Step 1: corrupt half of Group A actors (context.group 'A' → 'B') ────────
  // Simulates a business event or admin operation that overwrote the group field.
  const groupARows = db.prepare(
    `SELECT id, context_json FROM actors WHERE definition_id = ? AND org_id = ? AND status = 'active'`
  ).all(setup.v1Id, setup.orgId).filter(row => {
    const ctx = decryptContext(row.context_json, config.encryptionKey);
    return ctx.group === 'A';
  });

  const mutateCount = Math.floor(groupARows.length / 2);
  const mutateStmt  = db.prepare('UPDATE actors SET context_json = ? WHERE id = ?');
  for (let i = 0; i < mutateCount; i++) {
    const corrupted = encryptContext(
      { group: 'B', paid: false, label: 'waived fee', _mutated: true },
      config.encryptionKey,
    );
    mutateStmt.run(corrupted, groupARows[i].id);
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
    [setup.v1Id]: 'v1 (original / mutated stuck)',
    [v2Id]:       'v2 (paid path)',
    [v3Id]:       'v3 (rescued)',
  });

  return {
    approach: name, description, developerCode,
    phase1Ms, phase2Ms, totalMs: phase1Ms + phase2Ms,
    routing, dist,
    accuracyNote: true,
    notes: [
      `Corrupted ${mutateCount} of ${groupARows.length} Group A actors: context.group 'A' → 'B'`,
      `Context routing saw only ${groupA.length} Group A actors (missed ${mutateCount} mutated)`,
      `${mutateCount} actors stranded on v1 — context said 'B', so routing skipped them`,
      'APV immune: fingerprint = FNV(START·SUBMIT_INFO·PAY_FEE) — context mutation has no effect',
    ],
    risks: [
      'Context-based routing has no way to detect or recover from silent field corruption',
      'The ${mutateCount} misrouted actors are indistinguishable from real Group B in any context scan',
    ],
  };
}
