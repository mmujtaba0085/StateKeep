/**
 * src/registry/confirmTokenStore.js
 *
 * In-memory store for deployment confirmation tokens.
 *
 * A token is issued when PUT /v1/definitions detects stranded actors.
 * The caller must re-submit the PUT with the token to confirm they
 * understand actors will be tagged needs_rescue.
 *
 * Tokens are:
 *   - One-time use (deleted on consumption)
 *   - Short-lived (TOKEN_TTL_MS, default 5 minutes)
 *   - Drift-checked (if stranded actor count has grown since preview,
 *     the token is invalidated and a new preview is required)
 *
 * Stored in memory only — tokens do not survive server restarts.
 * This is intentional: a restart resets in-flight deployments, and the
 * caller must re-run their PUT to get a fresh preview.
 */

import { randomUUID } from 'crypto';

const TOKEN_TTL_MS    = parseInt(process.env.CONFIRM_TOKEN_TTL_MS ?? String(5 * 60 * 1000), 10);
const DRIFT_THRESHOLD = parseFloat(process.env.CONFIRM_DRIFT_THRESHOLD ?? '0.10'); // 10% growth

/** @type {Map<string, TokenEntry>} */
const store = new Map();

/**
 * @typedef {object} StrandedGroup
 * @property {string} state
 * @property {number} count
 */

/**
 * @typedef {object} TokenPayload
 * @property {string}          definitionId   — the new definition being deployed
 * @property {string}          parentId       — its parent definition
 * @property {string}          definitionHash — SHA-256 hex of the definition JSON
 * @property {string}          orgId          — org that issued the token
 * @property {StrandedGroup[]} strandedGroups — state → count snapshot at preview time
 * @property {number}          totalStranded  — total stranded actor count at preview
 */

/**
 * @typedef {object} TokenEntry
 * @property {TokenPayload} payload
 * @property {number}       expiresAt
 */

// ── Cleanup interval ──────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expiresAt < now) store.delete(id);
  }
}, 60_000).unref();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Issue a new confirmation token.
 * @param {TokenPayload} payload
 * @returns {{ token: string, expiresAt: number, expiresIn: number }}
 */
export function issueToken(payload) {
  const token     = randomUUID();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  store.set(token, { payload, expiresAt });
  return { token, expiresAt, expiresIn: Math.floor(TOKEN_TTL_MS / 1000) };
}

/**
 * Verify and consume a token.
 *
 * Also accepts `currentStrandedCount` to detect drift: if the number of
 * stranded actors has grown by more than DRIFT_THRESHOLD since preview,
 * the token is invalidated (but not deleted — let it expire naturally).
 *
 * @param {string} token
 * @param {{ definitionId: string, currentStrandedCount: number, orgId: string }} opts
 * @returns {{ ok: true, payload: TokenPayload } | { ok: false, reason: string, newPreviewNeeded?: boolean }}
 */
export function consumeToken(token, { definitionId, currentStrandedCount, orgId }) {
  const entry = store.get(token);

  if (!entry) {
    return { ok: false, reason: 'Token not found or already used' };
  }

  if (Date.now() > entry.expiresAt) {
    store.delete(token);
    return { ok: false, reason: 'Token has expired — re-submit without confirmToken to get a new preview', newPreviewNeeded: true };
  }

  if (entry.payload.orgId !== orgId) {
    return { ok: false, reason: 'Token org mismatch' };
  }

  if (entry.payload.definitionId !== definitionId) {
    return { ok: false, reason: `Token was issued for definition "${entry.payload.definitionId}", not "${definitionId}"` };
  }

  // Drift check — if stranded count grew by more than threshold, force re-preview
  const previewCount  = entry.payload.totalStranded;
  const growth        = previewCount > 0
    ? (currentStrandedCount - previewCount) / previewCount
    : (currentStrandedCount > 0 ? 1 : 0);

  if (growth > DRIFT_THRESHOLD) {
    store.delete(token);
    return {
      ok: false,
      reason: `Stranded actor count grew from ${previewCount} to ${currentStrandedCount} since preview (${(growth * 100).toFixed(0)}% increase exceeds ${(DRIFT_THRESHOLD * 100).toFixed(0)}% threshold) — re-submit without confirmToken to get a fresh preview`,
      newPreviewNeeded: true,
    };
  }

  // Valid — consume it
  store.delete(token);
  return { ok: true, payload: entry.payload };
}

/**
 * How many tokens are currently in the store (for monitoring).
 */
export function pendingCount() { return store.size; }
