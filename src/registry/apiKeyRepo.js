/**
 * src/registry/apiKeyRepo.js
 *
 * API key storage and validation.
 *
 * Key format: sk_<keyId>_<secret>
 *   keyId  = 8 hex chars  — stored in plain text as the lookup index
 *   secret = 40 hex chars — bcrypt-hashed, never stored raw
 *
 * Every key belongs to exactly one org (org_id column).
 * validateApiKey returns orgId so auth middleware can set req.orgId.
 */

import { getDb } from './db.js';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

const BCRYPT_ROUNDS = 10;

// Short-lived cache: rawKey → { keyInfo, cachedAt }
// Eliminates repeated bcrypt comparisons (each ~100–200ms) for the same key.
// TTL is intentionally short so revocations propagate within 60 s.
const KEY_CACHE     = new Map();
const KEY_CACHE_TTL = 60_000;

let stmts = null;

function getStmts() {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    insert:       db.prepare(`
      INSERT INTO api_keys (key_hash, key_id, label, tier, org_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    findByKeyId:  db.prepare(`
      SELECT key_hash, key_id, label, tier, org_id, created_at
      FROM api_keys WHERE key_id = ?
    `),
    findAll:      db.prepare(`
      SELECT key_hash, key_id, label, tier, org_id, created_at
      FROM api_keys ORDER BY created_at DESC
    `),
    deleteByKeyId: db.prepare(`DELETE FROM api_keys WHERE key_id = ?`),
    updateHash:   db.prepare(`UPDATE api_keys SET key_hash = ? WHERE key_id = ?`),
    listByOrg:    db.prepare(`
      SELECT key_id, label, tier, org_id, created_at
      FROM api_keys WHERE org_id = ? ORDER BY created_at DESC
    `),
    listAll:      db.prepare(`
      SELECT key_id, label, tier, org_id, created_at
      FROM api_keys ORDER BY created_at DESC
    `),
  };
  return stmts;
}

/**
 * Generate and store a new API key scoped to an org.
 * orgId is required — keys without an org are not permitted.
 * Returns { rawKey, keyId, label, tier, orgId } — rawKey shown exactly once.
 */
export async function createApiKey({ label, tier = 'free', orgId }) {
  if (!orgId) throw new Error('orgId is required when creating an API key');
  const keyId  = randomBytes(4).toString('hex');      // 8 hex chars
  const secret = randomBytes(20).toString('hex');     // 40 hex chars
  const rawKey = `sk_${keyId}_${secret}`;
  const hash   = await bcrypt.hash(secret, BCRYPT_ROUNDS);

  getStmts().insert.run(hash, keyId, label, tier, orgId, Date.now());
  return { rawKey, keyId, label, tier, orgId };
}

/**
 * Validate a raw key. Returns { keyId, label, tier, orgId } or null.
 *
 * Results are cached for KEY_CACHE_TTL ms so bcrypt (100–200ms per call)
 * only runs once per key per window, not on every request.
 * Invalid keys are never cached to avoid memory exhaustion from bad-key floods.
 */
export async function validateApiKey(rawKey) {
  const cached = KEY_CACHE.get(rawKey);
  if (cached && (Date.now() - cached.cachedAt) < KEY_CACHE_TTL) {
    return cached.keyInfo;
  }

  const s = getStmts();
  let keyInfo = null;

  // New format: sk_<keyId>_<secret>
  const match = rawKey.match(/^sk_([0-9a-f]{8})_([0-9a-f]{40})$/);
  if (match) {
    const [, keyId, secret] = match;
    const row = s.findByKeyId.get(keyId);
    if (row) {
      const ok = await bcrypt.compare(secret, row.key_hash);
      if (ok) keyInfo = { keyId: row.key_id, label: row.label, tier: row.tier, orgId: row.org_id ?? 'default' };
    }
  } else {
    // Legacy format: full raw key hashed — scan all (keep key count low)
    const rows = s.findAll.all();
    for (const row of rows) {
      const ok = await bcrypt.compare(rawKey, row.key_hash);
      if (ok) { keyInfo = { keyId: row.key_id ?? null, label: row.label, tier: row.tier, orgId: row.org_id ?? 'default' }; break; }
    }
  }

  if (keyInfo) KEY_CACHE.set(rawKey, { keyInfo, cachedAt: Date.now() });
  return keyInfo;
}

/**
 * Remove any cache entry associated with a keyId.
 * Call after revoke or rotate so the old key stops being accepted immediately.
 */
export function invalidateKeyCache(keyId) {
  for (const [raw, entry] of KEY_CACHE) {
    if (entry.keyInfo?.keyId === keyId) KEY_CACHE.delete(raw);
  }
}

/**
 * List all keys for a specific org (without hashes).
 */
export function listApiKeysByOrg(orgId) {
  return getStmts().listByOrg.all(orgId);
}

/**
 * List all keys in the system (admin use only, without hashes).
 */
export function listApiKeys() {
  return getStmts().listAll.all();
}

/**
 * Revoke a key by its keyId.
 */
export function revokeApiKey(keyId) {
  getStmts().deleteByKeyId.run(keyId);
  invalidateKeyCache(keyId);
}

/**
 * Rotate a key: generate a new secret, update the stored hash, return new rawKey.
 * Returns { rawKey, keyId, label, tier, rotatedAt } or null if key not found / wrong org.
 */
export async function rotateApiKey(keyId, orgId) {
  const s   = getStmts();
  const row = s.findByKeyId.get(keyId);
  if (!row || row.org_id !== orgId) return null;

  const secret = randomBytes(20).toString('hex');
  const rawKey = `sk_${keyId}_${secret}`;
  const hash   = await bcrypt.hash(secret, BCRYPT_ROUNDS);

  s.updateHash.run(hash, keyId);
  invalidateKeyCache(keyId);
  return { rawKey, keyId, label: row.label, tier: row.tier, rotatedAt: Date.now() };
}

/**
 * Pre-insert a key with a known hash (for install.sh seed / globalSetup).
 */
export function insertRawHash(keyHash, keyId, label, tier = 'pro', orgId = 'default') {
  getStmts().insert.run(keyHash, keyId, label, tier, orgId, Date.now());
}
