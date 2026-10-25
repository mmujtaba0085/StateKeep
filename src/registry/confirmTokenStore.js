/**
 * src/registry/confirmTokenStore.js
 *
 * Confirmation tokens for deployments that would strand actors, and the consent they record.
 *
 * A token is issued when PUT /v1/definitions predicts that actors would be stranded. It
 * records EXACTLY which actors the preview listed, and the definition it was issued for
 * (id and content hash). Re-submitting the same PUT with the token confirms it:
 *
 *   - the final prediction is recomputed under the family's deploy lock, immediately
 *     before the commit;
 *   - the deployment proceeds only if every actor it would now strand was in the preview
 *     (fewer is fine: an actor may have moved to a placeable state meanwhile);
 *   - otherwise a fresh preview is returned, naming the actors that were not in it.
 *
 * Tokens live in the database, so a preview from one API server can be confirmed through
 * any other, and a restart does not lose them. They are one-time and expire after
 * CONFIRM_TOKEN_TTL_MS (default 5 minutes).
 *
 * After the commit, the consented actors are recorded per target definition
 * (recordConsent), so a stranding that the operator did not see in the preview — an actor
 * whose state changed between the final check and the commit — is reported by
 * actorManager.strandActor (webhook actor.stranded with consented: false) rather than
 * passing silently.
 */

import { randomUUID } from 'crypto';
import { getDb, isPostgres } from './db.js';

const TOKEN_TTL_MS = parseInt(process.env.CONFIRM_TOKEN_TTL_MS ?? String(5 * 60 * 1000), 10);

async function pgq() { return import('./db-postgres.js'); }

/**
 * Issue a token for a preview.
 * @param {{ definitionId: string, definitionHash: string, actorIds: string[] }} p
 * @returns {Promise<{ token: string, expiresAt: number, expiresIn: number }>}
 */
export async function issueToken({ definitionId, definitionHash, actorIds }) {
  const token = randomUUID();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const ids = JSON.stringify([...new Set(actorIds)].sort());
  if (isPostgres) {
    const { query } = await pgq();
    await query(`DELETE FROM confirm_tokens WHERE expires_at < $1`, [Date.now()]);
    await query(`INSERT INTO confirm_tokens (token, definition_id, definition_hash, actor_ids, expires_at) VALUES ($1,$2,$3,$4,$5)`,
      [token, definitionId, definitionHash, ids, expiresAt]);
  } else {
    const db = getDb();
    db.prepare(`DELETE FROM confirm_tokens WHERE expires_at < ?`).run(Date.now());
    db.prepare(`INSERT INTO confirm_tokens (token, definition_id, definition_hash, actor_ids, expires_at) VALUES (?,?,?,?,?)`)
      .run(token, definitionId, definitionHash, ids, expiresAt);
  }
  return { token, expiresAt, expiresIn: Math.floor(TOKEN_TTL_MS / 1000) };
}

async function takeToken(token) {
  if (isPostgres) {
    const { queryOne } = await pgq();
    return queryOne(`DELETE FROM confirm_tokens WHERE token = $1 RETURNING definition_id, definition_hash, actor_ids, expires_at`, [token]);
  }
  return getDb().prepare(`DELETE FROM confirm_tokens WHERE token = ? RETURNING definition_id, definition_hash, actor_ids, expires_at`).get(token);
}

async function peekToken(token) {
  if (isPostgres) {
    const { queryOne } = await pgq();
    return queryOne(`SELECT definition_id FROM confirm_tokens WHERE token = $1`, [token]);
  }
  return getDb().prepare(`SELECT definition_id FROM confirm_tokens WHERE token = ?`).get(token);
}

/**
 * Check a token against the prediction made just before the commit, and consume it.
 * @returns {Promise<{ ok: true, actorIds: string[] } |
 *                   { ok: false, reason: string, newPreviewNeeded?: boolean, unconsented?: string[] }>}
 */
export async function consumeToken(token, { definitionId, definitionHash, strandedIds }) {
  // A token issued for another definition is a client error: report it, keep the token.
  const peek = await peekToken(token);
  if (peek && peek.definition_id !== definitionId) {
    return { ok: false, reason: `Token was issued for definition "${peek.definition_id}", not "${definitionId}"` };
  }
  const row = await takeToken(token);
  if (!row) {
    return { ok: false, reason: 'Token not found, already used or expired — this is a fresh preview', newPreviewNeeded: true };
  }
  if (Date.now() > Number(row.expires_at)) {
    return { ok: false, reason: 'Token has expired — this is a fresh preview', newPreviewNeeded: true };
  }
  if (row.definition_hash !== definitionHash) {
    return { ok: false, reason: 'The definition changed since the preview — this is a fresh preview', newPreviewNeeded: true };
  }
  const consented = new Set(JSON.parse(row.actor_ids));
  const unconsented = strandedIds.filter((id) => !consented.has(id));
  if (unconsented.length > 0) {
    return {
      ok: false, newPreviewNeeded: true, unconsented,
      reason: `${unconsented.length} actor(s) that were not in the preview would now be stranded ` +
              `(their state changed since) — this is a fresh preview including them`,
    };
  }
  return { ok: true, actorIds: [...consented] };
}

/** Record which actors were consented for a deployment (replacing an earlier attempt's). */
export async function recordConsent(definitionId, actorIds) {
  if (isPostgres) {
    const { query } = await pgq();
    await query(`DELETE FROM stranding_consents WHERE definition_id = $1`, [definitionId]);
    for (const id of actorIds ?? []) {
      await query(`INSERT INTO stranding_consents (definition_id, actor_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [definitionId, id]);
    }
    return;
  }
  const db = getDb();
  const ins = db.prepare(`INSERT OR IGNORE INTO stranding_consents (definition_id, actor_id) VALUES (?, ?)`);
  db.transaction(() => {
    db.prepare(`DELETE FROM stranding_consents WHERE definition_id = ?`).run(definitionId);
    for (const id of actorIds ?? []) ins.run(definitionId, id);
  })();
}

/** Was stranding this actor at this target consented in a preview? */
export async function strandingConsented(definitionId, actorId) {
  if (isPostgres) {
    const { queryOne } = await pgq();
    return !!(await queryOne(`SELECT 1 AS x FROM stranding_consents WHERE definition_id = $1 AND actor_id = $2`, [definitionId, actorId]));
  }
  return !!getDb().prepare(`SELECT 1 AS x FROM stranding_consents WHERE definition_id = ? AND actor_id = ?`).get(definitionId, actorId);
}
