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
 * Validate a raw key. O(1) for new-format keys, O(n) fallback for legacy keys.
 * Returns { keyId, label, tier, orgId } or null.
 */
export async function validateApiKey(rawKey) {
  const s = getStmts();

  // New format: sk_<keyId>_<secret>
  const match = rawKey.match(/^sk_([0-9a-f]{8})_([0-9a-f]{40})$/);
  if (match) {
    const [, keyId, secret] = match;
    const row = s.findByKeyId.get(keyId);
    if (!row) return null;
    const ok = await bcrypt.compare(secret, row.key_hash);
    return ok ? { keyId: row.key_id, label: row.label, tier: row.tier, orgId: row.org_id ?? 'default' } : null;
  }

  // Legacy format: full raw key hashed — scan all (keep key count low)
  const rows = s.findAll.all();
  for (const row of rows) {
    const ok = await bcrypt.compare(rawKey, row.key_hash);
    if (ok) return { keyId: row.key_id ?? null, label: row.label, tier: row.tier, orgId: row.org_id ?? 'default' };
  }
  return null;
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
  return { rawKey, keyId, label: row.label, tier: row.tier, rotatedAt: Date.now() };
}

/**
 * Pre-insert a key with a known hash (for install.sh seed / globalSetup).
 */
export function insertRawHash(keyHash, keyId, label, tier = 'pro', orgId = 'default') {
  getStmts().insert.run(keyHash, keyId, label, tier, orgId, Date.now());
}
