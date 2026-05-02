/**
 * test/globalSetup.js
 *
 * Runs once before the test webServer starts.
 * Pre-seeds STATEKEEP_API_KEY into statekeep-test.db so Playwright's
 * isolated test server accepts the same key the user passes on the CLI.
 *
 * Also ensures the 'default' org exists and the seeded key belongs to it.
 */

export default async function globalSetup() {
  const rawKey = process.env.STATEKEEP_API_KEY;
  if (!rawKey) return;

  const match = rawKey.match(/^sk_([0-9a-f]{8})_([0-9a-f]{40})$/);
  if (!match) return;

  const [, keyId, secret] = match;

  // Mirror the env the webServer will use
  process.env.STATEKEEP_DB_PATH        = 'statekeep-test.db';
  process.env.STATEKEEP_ENCRYPTION_KEY = '0'.repeat(64);
  process.env.STATEKEEP_ADMIN_KEY      = 'test-admin-key';

  // Lazy-import so the module sees the env vars above
  const { default: bcrypt } = await import('bcryptjs');
  const { getDb }           = await import('../src/registry/db.js');

  const db   = getDb();
  // Use 4 rounds for speed in tests (security irrelevant here)
  const hash = await bcrypt.hash(secret, 4);

  // Ensure default org exists (migration v6 adds this via INSERT OR IGNORE, but
  // globalSetup runs before the server starts so we ensure it here too)
  try {
    db.prepare(`INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES ('default', 'Default Org', ?)`).run(Date.now());
  } catch {}

  // Upsert: replace any existing row with same key_id, scoped to 'default' org
  db.prepare(`
    INSERT OR REPLACE INTO api_keys (key_hash, key_id, label, tier, org_id, created_at)
    VALUES (?, ?, 'test-bootstrap', 'enterprise', 'default', ?)
  `).run(hash, keyId, Date.now());
}
