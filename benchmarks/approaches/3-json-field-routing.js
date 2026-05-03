/**
 * benchmarks/approaches/3-json-field-routing.js
 *
 * APPROACH: Context field inspection via direct SQLite access — 2 phases.
 *
 * The developer stores context.group ('A'/'B'/'C') on every actor at spawn time.
 * A migration script decrypts context, filters by group, and updates definition_id.
 *
 * Phase 1: Find group='A' actors → migrate to v2.
 * Phase 2: Find group='C' actors → migrate to v3, update state_value to 'rescued'.
 *
 * Accuracy: 100% in this benchmark (perfect flag hygiene).
 * In production: silently wrong if flags were ever missed or set incorrectly.
 * Developer cost: ~30 lines.
 *
 * REQUIRES: STATEKEEP_DB_PATH + STATEKEEP_ENCRYPTION_KEY.
 */

import Database             from 'better-sqlite3';
import { createDecipheriv } from 'crypto';
import { LOAN_V2, LOAN_V3 } from '../shared/scenarios.js';
import { verifyRouting, getActorDistribution } from '../shared/setup.js';

export const name          = '3-json-field-routing';
export const description   = '3. Context field (decrypt+filter, ~30 dev lines)';
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

  const v2Id = `loan-v2-ctx-${setup.runId}`;
  const v3Id = `loan-v3-ctx-${setup.runId}`;

  for (const [id, def] of [[v2Id, LOAN_V2], [v3Id, LOAN_V3]]) {
    const r = await client.put('/v1/definitions', { id, definition: def }, setup.apiKey);
    if (r.status !== 201 && r.status !== 200) throw new Error(`Deploy ${id} failed: ${r.status}`);
  }

  const db   = new Database(config.dbPath, { readonly: false });
  const rows = db.prepare(
    `SELECT id, context_json FROM actors WHERE definition_id = ? AND org_id = ? AND status IN ('active','needs_rescue')`
  ).all(setup.v1Id, setup.orgId);

  const groupA = [], groupC = [];
  for (const row of rows) {
    const ctx = decryptContext(row.context_json, config.encryptionKey);
    if (ctx.group === 'A') groupA.push(row.id);
    if (ctx.group === 'C') groupC.push(row.id);
  }

  // ── Phase 1: migrate Group A → v2 ─────────────────────────────────────────
  const p1Start = performance.now();
  if (groupA.length > 0) {
    const stmt = db.prepare('UPDATE actors SET definition_id = ? WHERE id = ?');
    db.transaction(ids => { for (const id of ids) stmt.run(v2Id, id); })(groupA);
  }
  const phase1Ms = Math.round(performance.now() - p1Start);

  // ── Phase 2: rescue Group C → v3 with stateMapping applied manually ───────
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
    [setup.v1Id]: 'v1 (original)',
    [v2Id]:       'v2 (paid path)',
    [v3Id]:       'v3 (rescued)',
  });

  return {
    approach: name, description, developerCode,
    phase1Ms, phase2Ms, totalMs: phase1Ms + phase2Ms,
    routing, dist,
    accuracyNote: true,
    notes: [
      `Phase 1: decrypted ${rows.length} contexts, migrated ${groupA.length} Group A → v2`,
      `Phase 2: migrated ${groupC.length} Group C → v3, manually applied stateMapping`,
      'Group B (waived fee) correctly stays on v1 via context.group filter',
    ],
    risks: [
      'Silently wrong if context.group flag ever missed or set incorrectly on any actor',
      'Requires STATEKEEP_ENCRYPTION_KEY in the migration script',
      'state_value and status updated directly — bypasses hot registry and audit trail',
    ],
  };
}
