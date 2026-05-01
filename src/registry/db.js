/**
 * src/registry/db.js
 *
 * better-sqlite3 singleton with WAL mode, encryption helpers, and automatic
 * schema bootstrap. Every process that imports this module gets the same
 * in-process connection (one connection per process, which is the
 * better-sqlite3 recommended pattern).
 */

import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { mkdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Environment ──────────────────────────────────────────────────────────────

const DB_PATH = process.env.STATEKEEP_DB_PATH || './statekeep.db';

const ENC_KEY_HEX = process.env.STATEKEEP_ENCRYPTION_KEY;
if (!ENC_KEY_HEX || ENC_KEY_HEX.length !== 64) {
  console.error(
    '[db] WARNING: STATEKEEP_ENCRYPTION_KEY is not set or not 64 hex chars. ' +
    'Data at rest will NOT be encrypted.'
  );
}
const ENCRYPTION_KEY = ENC_KEY_HEX
  ? Buffer.from(ENC_KEY_HEX, 'hex')
  : null;

const ALGORITHM  = 'aes-256-gcm';
const IV_LEN     = 12;   // 96-bit nonce for GCM
const TAG_LEN    = 16;   // 128-bit auth tag

// ── Crypto helpers ───────────────────────────────────────────────────────────

/**
 * Encrypt a Buffer or string with AES-256-GCM.
 * Returns a Buffer: [ IV (12) | AuthTag (16) | Ciphertext ]
 * If no key is configured, returns the plaintext as-is (Buffer).
 */
export function encrypt(plaintext) {
  if (!ENCRYPTION_KEY) {
    return Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  }
  const iv       = randomBytes(IV_LEN);
  const cipher   = createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  const body     = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const enc      = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag      = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

/**
 * Decrypt a Buffer produced by encrypt().
 * Returns the plaintext as a Buffer.
 */
export function decrypt(ciphertext) {
  if (!ENCRYPTION_KEY) return ciphertext;
  if (!Buffer.isBuffer(ciphertext)) ciphertext = Buffer.from(ciphertext);
  const iv       = ciphertext.slice(0, IV_LEN);
  const tag      = ciphertext.slice(IV_LEN, IV_LEN + TAG_LEN);
  const enc      = ciphertext.slice(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

// ── Database singleton ────────────────────────────────────────────────────────

let _db = null;

export function getDb() {
  if (_db) return _db;

  _db = new Database(DB_PATH, {
    // verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
  });

  // WAL mode, recommended pragmas
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');   // wait up to 5s before SQLITE_BUSY
  _db.pragma('synchronous  = NORMAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('cache_size   = -32000');   // 32 MB
  _db.pragma('temp_store   = MEMORY');
  _db.pragma('wal_autocheckpoint = 1000');

  // Bootstrap schema
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  // Execute statement by statement (better-sqlite3 exec handles multiple)
  _db.exec(schema);

  // ── Live migrations (applied to existing databases) ──────────────────────
  // Each migration is guarded by INSERT OR IGNORE into schema_migrations so it
  // is safe to re-run on every startup — only missing migrations are applied.

  const appliedVersions = new Set(
    _db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
  );

  // v3 — Add needs_rescue to actors status CHECK
  // SQLite does not support ALTER COLUMN, so we rebuild actors with the new CHECK.
  if (!appliedVersions.has(3)) {
    _db.exec(`
      BEGIN;

      -- Rename old table
      ALTER TABLE actors RENAME TO actors_v2;

      -- Recreate with updated CHECK
      CREATE TABLE actors (
          id                   TEXT PRIMARY KEY,
          definition_id        TEXT NOT NULL REFERENCES definitions(id),
          state_value          TEXT,
          context_json         BLOB,
          logical_start_tick   INTEGER NOT NULL DEFAULT 0,
          history_fingerprint  TEXT NOT NULL DEFAULT '0',
          last_event_tick      INTEGER,
          status               TEXT NOT NULL DEFAULT 'active'
                               CHECK(status IN ('active','migrating','terminated','archived','needs_rescue')),
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL
      );

      -- Copy data
      INSERT INTO actors SELECT * FROM actors_v2;

      -- Drop old table
      DROP TABLE actors_v2;

      -- Restore indexes
      CREATE INDEX IF NOT EXISTS idx_actors_definition ON actors(definition_id);
      CREATE INDEX IF NOT EXISTS idx_actors_status     ON actors(status);
      CREATE INDEX IF NOT EXISTS idx_actors_updated    ON actors(updated_at);
      CREATE INDEX IF NOT EXISTS idx_actors_rescue     ON actors(status) WHERE status = 'needs_rescue';

      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, unixepoch());

      COMMIT;
    `);
    console.log('[db] Migration v3 applied: needs_rescue status added to actors');
  }

  // v4 — Add migration_decisions table for queryable per-actor decision log
  if (!appliedVersions.has(4)) {
    _db.exec(`
      BEGIN;

      CREATE TABLE IF NOT EXISTS migration_decisions (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_id            TEXT NOT NULL REFERENCES actors(id),
          deployment_id       TEXT REFERENCES deployments(id),
          trigger             TEXT NOT NULL
                              CHECK(trigger IN ('inline_event','batch_worker','preview')),
          evaluated_at        INTEGER NOT NULL,
          decision            TEXT NOT NULL
                              CHECK(decision IN ('migrated','stayed','failed','cancelled')),
          reason              TEXT NOT NULL,
          from_definition_id  TEXT,
          to_definition_id    TEXT,
          actor_fingerprint   TEXT NOT NULL,
          prefix_hash         TEXT NOT NULL,
          created_at          INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_actor      ON migration_decisions(actor_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_deployment ON migration_decisions(deployment_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_decision   ON migration_decisions(decision);
      CREATE INDEX IF NOT EXISTS idx_decisions_evaluated  ON migration_decisions(evaluated_at);

      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, unixepoch());

      COMMIT;
    `);
    console.log('[db] Migration v4 applied: migration_decisions table added');
  }

  // v5 — Add machine_id to definitions (root = own id, children inherit from root)
  if (!appliedVersions.has(5)) {
    _db.exec(`
      BEGIN;

      ALTER TABLE definitions ADD COLUMN machine_id TEXT;

      -- Root definitions own their id
      UPDATE definitions SET machine_id = id WHERE parent_id IS NULL;

      -- Propagate machine_id down the tree (up to 10 levels deep)
      UPDATE definitions SET machine_id = (
        WITH RECURSIVE chain(id, machine_id) AS (
          SELECT id, machine_id FROM definitions WHERE parent_id IS NULL
          UNION ALL
          SELECT d.id, c.machine_id FROM definitions d
          JOIN chain c ON d.parent_id = c.id
        )
        SELECT chain.machine_id FROM chain WHERE chain.id = definitions.id
      ) WHERE machine_id IS NULL;

      CREATE INDEX IF NOT EXISTS idx_definitions_machine ON definitions(machine_id);

      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (5, unixepoch());
      COMMIT;
    `);
    console.log('[db] Migration v5 applied: machine_id added to definitions');
  }

  // v6 — Multi-tenancy: add orgs table + org_id to all data tables
  if (!appliedVersions.has(6)) {
    _db.exec(`
      BEGIN;

      CREATE TABLE IF NOT EXISTS orgs (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          created_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES ('default', 'Default Org', unixepoch());

      ALTER TABLE api_keys            ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE definitions         ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE actors              ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE deployments         ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE migration_jobs      ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE migration_decisions ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE metrics_snapshots   ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';

      CREATE INDEX IF NOT EXISTS idx_actors_org      ON actors(org_id);
      CREATE INDEX IF NOT EXISTS idx_definitions_org ON definitions(org_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_org   ON migration_decisions(org_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_org        ON migration_jobs(org_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_org    ON api_keys(org_id);

      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (6, unixepoch());
      COMMIT;
    `);
    console.log('[db] Migration v6 applied: multi-tenancy org_id added to all tables');
  }

  // v7 — Add org_id to events table (FIX-3: events separated from v6 to handle staggered rollouts)
  if (!appliedVersions.has(7)) {
    const hasCol = _db.prepare(
      `SELECT COUNT(*) as cnt FROM pragma_table_info('events') WHERE name = 'org_id'`
    ).get().cnt > 0;

    if (!hasCol) {
      _db.exec(`ALTER TABLE events ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';`);
    }
    _db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_org ON events(org_id);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (7, unixepoch());
    `);
    console.log('[db] Migration v7 applied: org_id added to events table');
  }

  // v8 — Add scheduled_events table
  if (!appliedVersions.has(8)) {
    _db.exec(`
      BEGIN;

      CREATE TABLE IF NOT EXISTS scheduled_events (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_id    TEXT NOT NULL REFERENCES actors(id),
          org_id      TEXT NOT NULL DEFAULT 'default',
          event_type  TEXT NOT NULL,
          payload_enc BLOB,
          fire_at     INTEGER NOT NULL,
          status      TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','fired','failed','cancelled')),
          fired_at    INTEGER,
          error       TEXT,
          created_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sched_actor   ON scheduled_events(actor_id);
      CREATE INDEX IF NOT EXISTS idx_sched_fire_at ON scheduled_events(fire_at) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_sched_org     ON scheduled_events(org_id);

      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (8, unixepoch());
      COMMIT;
    `);
    console.log('[db] Migration v8 applied: scheduled_events table added');
  }

  // v9 — Add worker_heartbeats table
  if (!appliedVersions.has(9)) {
    _db.exec(`
      BEGIN;

      CREATE TABLE IF NOT EXISTS worker_heartbeats (
          worker_id    TEXT PRIMARY KEY,
          worker_type  TEXT NOT NULL
                       CHECK(worker_type IN ('migrate','gc','snapshot','metrics','scheduler')),
          last_beat    INTEGER NOT NULL,
          started_at   INTEGER NOT NULL,
          pid          INTEGER NOT NULL
      );

      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (9, unixepoch());
      COMMIT;
    `);
    console.log('[db] Migration v9 applied: worker_heartbeats table added');
  }

  // v10 — Add retry columns to scheduled_events + actor_archives table
  if (!appliedVersions.has(10)) {
    _db.exec(`
      BEGIN;

      ALTER TABLE scheduled_events ADD COLUMN retry_count  INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE scheduled_events ADD COLUMN max_retries  INTEGER NOT NULL DEFAULT 3;
      ALTER TABLE scheduled_events ADD COLUMN next_retry_at INTEGER;

      CREATE TABLE IF NOT EXISTS actor_archives (
          actor_id      TEXT PRIMARY KEY,
          org_id        TEXT NOT NULL,
          machine_id    TEXT,
          archived_at   INTEGER NOT NULL,
          file_path     TEXT NOT NULL,
          state_value   TEXT,
          definition_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_archives_org ON actor_archives(org_id);

      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (10, unixepoch());
      COMMIT;
    `);
    console.log('[db] Migration v10 applied: scheduled_events retry columns + actor_archives table');
  }

  // v11 — Webhook tables + 'webhook' added to worker_heartbeats CHECK
  if (!appliedVersions.has(11)) {
    _db.exec(`
      BEGIN;

      -- Rebuild worker_heartbeats with 'webhook' added to CHECK constraint.
      -- SQLite does not support ALTER COLUMN, so recreate the table.
      ALTER TABLE worker_heartbeats RENAME TO worker_heartbeats_v10;
      CREATE TABLE worker_heartbeats (
          worker_id    TEXT PRIMARY KEY,
          worker_type  TEXT NOT NULL
                       CHECK(worker_type IN ('migrate','gc','snapshot','metrics','scheduler','webhook')),
          last_beat    INTEGER NOT NULL,
          started_at   INTEGER NOT NULL,
          pid          INTEGER NOT NULL
      );
      INSERT INTO worker_heartbeats SELECT * FROM worker_heartbeats_v10;
      DROP TABLE worker_heartbeats_v10;

      CREATE TABLE IF NOT EXISTS webhooks (
          id            TEXT PRIMARY KEY,
          org_id        TEXT NOT NULL,
          url           TEXT NOT NULL,
          secret        BLOB NOT NULL,
          events        TEXT NOT NULL,
          active        INTEGER NOT NULL DEFAULT 1,
          created_at    INTEGER NOT NULL,
          last_fired_at INTEGER,
          failure_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(org_id);

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id            TEXT PRIMARY KEY,
          webhook_id    TEXT NOT NULL REFERENCES webhooks(id),
          org_id        TEXT NOT NULL,
          event_type    TEXT NOT NULL,
          payload       TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','delivered','failed')),
          attempts      INTEGER NOT NULL DEFAULT 0,
          next_retry_at INTEGER,
          last_attempt  INTEGER,
          response_code INTEGER,
          error         TEXT,
          created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id);
      CREATE INDEX IF NOT EXISTS idx_deliveries_pending  ON webhook_deliveries(status) WHERE status = 'pending';

      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (11, unixepoch());
      COMMIT;
    `);
    console.log('[db] Migration v11 applied: webhooks + webhook_deliveries tables; webhook worker type added');
  }

  // v12 — Changepoints table for cross-process APV registry seeding
  if (!appliedVersions.has(12)) {
    _db.exec(`
      BEGIN;

      CREATE TABLE IF NOT EXISTS changepoints (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          org_id       TEXT NOT NULL,
          t_star       INTEGER NOT NULL,
          prefix_hash  TEXT NOT NULL,
          refinement   INTEGER NOT NULL DEFAULT 0,
          child_def_id TEXT NOT NULL,
          created_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_changepoints_org ON changepoints(org_id);

      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (12, unixepoch());
      COMMIT;
    `);
    console.log('[db] Migration v12 applied: changepoints table added');
  }

  // Graceful shutdown
  process.on('exit',    () => { try { _db.close(); } catch {} });
  process.on('SIGINT',  () => { process.exit(0); });
  process.on('SIGTERM', () => { process.exit(0); });

  return _db;
}

export default getDb;
