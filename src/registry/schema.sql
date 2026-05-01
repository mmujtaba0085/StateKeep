-- ─────────────────────────────────────────────────────────────────────────────
-- StateKeep — Canonical SQLite Schema  (v9)
-- Applied automatically by src/registry/db.js on first connection.
-- ─────────────────────────────────────────────────────────────────────────────

PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size   = -32000;
PRAGMA temp_store   = MEMORY;

-- ── Organisations ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orgs (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES ('default', 'Default Org', unixepoch());

-- ── Machine definitions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS definitions (
    id              TEXT PRIMARY KEY,
    parent_id       TEXT REFERENCES definitions(id),
    machine_id      TEXT,
    definition_json BLOB NOT NULL,
    deployed_at     INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active','deprecated','pruned')),
    org_id          TEXT NOT NULL DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_definitions_parent  ON definitions(parent_id);
CREATE INDEX IF NOT EXISTS idx_definitions_status  ON definitions(status);
CREATE INDEX IF NOT EXISTS idx_definitions_machine ON definitions(machine_id);
CREATE INDEX IF NOT EXISTS idx_definitions_org     ON definitions(org_id);

-- ── Actors ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS actors (
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
    updated_at           INTEGER NOT NULL,
    org_id               TEXT NOT NULL DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_actors_definition ON actors(definition_id);
CREATE INDEX IF NOT EXISTS idx_actors_status     ON actors(status);
CREATE INDEX IF NOT EXISTS idx_actors_updated    ON actors(updated_at);
CREATE INDEX IF NOT EXISTS idx_actors_rescue     ON actors(status) WHERE status = 'needs_rescue';
CREATE INDEX IF NOT EXISTS idx_actors_org        ON actors(org_id);

-- ── Event log ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id        TEXT NOT NULL REFERENCES actors(id),
    org_id          TEXT NOT NULL DEFAULT 'default',
    event_type      TEXT NOT NULL,
    event_payload   BLOB,
    tick            INTEGER NOT NULL,
    processed_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_actor        ON events(actor_id);
CREATE INDEX IF NOT EXISTS idx_events_processed_at ON events(processed_at);

-- ── Deployments ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deployments (
    id               TEXT PRIMARY KEY,
    definition_id    TEXT NOT NULL REFERENCES definitions(id),
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','migrating','complete','failed')),
    affected_actors  INTEGER NOT NULL DEFAULT 0,
    migrated_count   INTEGER NOT NULL DEFAULT 0,
    failed_count     INTEGER NOT NULL DEFAULT 0,
    started_at       INTEGER,
    completed_at     INTEGER,
    org_id           TEXT NOT NULL DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_deployments_defid  ON deployments(definition_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);

-- ── Migration jobs ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS migration_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id   TEXT NOT NULL REFERENCES deployments(id),
    actor_id        TEXT NOT NULL REFERENCES actors(id),
    target_def_id   TEXT NOT NULL REFERENCES definitions(id),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','processing','done','failed')),
    error_message   TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    org_id          TEXT NOT NULL DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_jobs_status     ON migration_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_deployment ON migration_jobs(deployment_id);
CREATE INDEX IF NOT EXISTS idx_jobs_actor      ON migration_jobs(actor_id);
CREATE INDEX IF NOT EXISTS idx_jobs_org        ON migration_jobs(org_id);

-- ── API keys ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
    key_hash    TEXT PRIMARY KEY,
    key_id      TEXT,                -- 8-hex lookup index (new format keys)
    label       TEXT NOT NULL,
    tier        TEXT NOT NULL DEFAULT 'free'
                CHECK(tier IN ('free','pro','enterprise')),
    created_at  INTEGER NOT NULL,
    org_id      TEXT NOT NULL DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_id ON api_keys(key_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_org    ON api_keys(org_id);

-- ── Metrics snapshots ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS metrics_snapshots (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at             INTEGER NOT NULL,
    active_actors           INTEGER NOT NULL DEFAULT 0,
    migrating_actors        INTEGER NOT NULL DEFAULT 0,
    archived_actors         INTEGER NOT NULL DEFAULT 0,
    definitions_count       INTEGER NOT NULL DEFAULT 0,
    pending_jobs            INTEGER NOT NULL DEFAULT 0,
    ffi_calls_total         INTEGER NOT NULL DEFAULT 0,
    ffi_latency_p50_ms      REAL    NOT NULL DEFAULT 0,
    ffi_latency_p99_ms      REAL    NOT NULL DEFAULT 0,
    api_requests_total      INTEGER NOT NULL DEFAULT 0,
    api_latency_p50_ms      REAL    NOT NULL DEFAULT 0,
    api_latency_p95_ms      REAL    NOT NULL DEFAULT 0,
    api_latency_p99_ms      REAL    NOT NULL DEFAULT 0,
    wal_size_bytes          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_metrics_captured ON metrics_snapshots(captured_at);

-- ── Schema version tracking ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL
);

-- ── Migration decision log ────────────────────────────────────────────────────
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
    created_at          INTEGER NOT NULL,
    org_id              TEXT NOT NULL DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_decisions_actor      ON migration_decisions(actor_id);
CREATE INDEX IF NOT EXISTS idx_decisions_deployment ON migration_decisions(deployment_id);
CREATE INDEX IF NOT EXISTS idx_decisions_decision   ON migration_decisions(decision);
CREATE INDEX IF NOT EXISTS idx_decisions_evaluated  ON migration_decisions(evaluated_at);
CREATE INDEX IF NOT EXISTS idx_decisions_org        ON migration_decisions(org_id);

-- ── Scheduled events ─────────────────────────────────────────────────────────
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

-- ── Worker heartbeats ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker_heartbeats (
    worker_id    TEXT PRIMARY KEY,
    worker_type  TEXT NOT NULL
                 CHECK(worker_type IN ('migrate','gc','snapshot','metrics','scheduler','webhook')),
    last_beat    INTEGER NOT NULL,
    started_at   INTEGER NOT NULL,
    pid          INTEGER NOT NULL
);

-- ── Webhooks ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhooks (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL,
    url           TEXT NOT NULL,
    secret        BLOB NOT NULL,        -- HMAC signing secret, AES-256-GCM encrypted
    events        TEXT NOT NULL,        -- JSON array of subscribed event type strings
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    last_fired_at INTEGER,
    failure_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(org_id);

-- ── Webhook delivery log ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id            TEXT PRIMARY KEY,
    webhook_id    TEXT NOT NULL REFERENCES webhooks(id),
    org_id        TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    payload       TEXT NOT NULL,        -- full JSON payload sent to the endpoint
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

-- ── Changepoints (APV engine registry — persisted for cross-process seeding) ──
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

INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (5, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (6, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (8, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (9, unixepoch());
