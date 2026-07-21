-- ─────────────────────────────────────────────────────────────────────────────
-- StateKeep — Canonical SQLite Schema  (v25)
-- Applied automatically by src/registry/db.js on first connection.
-- PRAGMAs are set by db.js before this file is exec'd — do not add them here.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Schema version tracking ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL
);

-- ── Machine definitions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS definitions (
    id              TEXT PRIMARY KEY,
    parent_id       TEXT REFERENCES definitions(id),
    machine_id      TEXT,
    definition_json BLOB NOT NULL,
    compiled_json   TEXT,
    deployed_at     INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active','deprecated','pruned')),
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_definitions_parent  ON definitions(parent_id);
CREATE INDEX IF NOT EXISTS idx_definitions_status  ON definitions(status);
CREATE INDEX IF NOT EXISTS idx_definitions_machine ON definitions(machine_id);

-- ── Actors ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS actors (
    id                   TEXT PRIMARY KEY,
    definition_id        TEXT NOT NULL REFERENCES definitions(id),
    state_value          TEXT,
    context_json         BLOB,
    logical_start_tick   INTEGER NOT NULL DEFAULT 0,
    history_fingerprint  TEXT NOT NULL DEFAULT '0',
    region_fingerprints  TEXT,
    last_event_tick      INTEGER,
    state_entry_id       INTEGER NOT NULL DEFAULT 0,
    status               TEXT NOT NULL DEFAULT 'active'
                         CHECK(status IN ('active','migrating','terminated','archived','needs_rescue')),
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_actors_def     ON actors(definition_id);
CREATE INDEX IF NOT EXISTS idx_actors_status  ON actors(status);
CREATE INDEX IF NOT EXISTS idx_actors_updated ON actors(updated_at);
CREATE INDEX IF NOT EXISTS idx_actors_rescue  ON actors(status) WHERE status = 'needs_rescue';

-- ── Event log ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id        TEXT NOT NULL REFERENCES actors(id),
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
    completed_at     INTEGER
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
    updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status     ON migration_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_deployment ON migration_jobs(deployment_id);
CREATE INDEX IF NOT EXISTS idx_jobs_actor      ON migration_jobs(actor_id);

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
    created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_actor      ON migration_decisions(actor_id);
CREATE INDEX IF NOT EXISTS idx_decisions_deployment ON migration_decisions(deployment_id);
CREATE INDEX IF NOT EXISTS idx_decisions_decision   ON migration_decisions(decision);
CREATE INDEX IF NOT EXISTS idx_decisions_evaluated  ON migration_decisions(evaluated_at);

-- ── Scheduled events ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id      TEXT NOT NULL REFERENCES actors(id),
    event_type    TEXT NOT NULL,
    payload_enc   BLOB,
    fire_at       INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','fired','failed','cancelled')),
    fired_at      INTEGER,
    error         TEXT,
    created_at    INTEGER NOT NULL,
    retry_count   INTEGER NOT NULL DEFAULT 0,
    max_retries   INTEGER NOT NULL DEFAULT 3,
    next_retry_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sched_actor   ON scheduled_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_sched_fire_at ON scheduled_events(fire_at) WHERE status = 'pending';

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
    url           TEXT NOT NULL,
    secret        BLOB NOT NULL,
    events        TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    last_fired_at INTEGER,
    failure_count INTEGER NOT NULL DEFAULT 0
);

-- ── Webhook delivery log ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id            TEXT PRIMARY KEY,
    webhook_id    TEXT NOT NULL REFERENCES webhooks(id),
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
CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON webhook_deliveries(status) WHERE status = 'pending';

-- ── Changepoints (APV engine registry) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS changepoints (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    t_star       INTEGER NOT NULL,
    prefix_hash  TEXT NOT NULL,
    refinement   INTEGER NOT NULL DEFAULT 0,
    child_def_id TEXT NOT NULL,
    created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_changepoints_unique
  ON changepoints(t_star, prefix_hash, refinement);

-- ── Parallel changepoints ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS par_changepoints (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    t_star       INTEGER NOT NULL,
    region_hashes TEXT NOT NULL,
    refinement   INTEGER NOT NULL DEFAULT 0,
    child_def_id TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_par_changepoints_unique
  ON par_changepoints(child_def_id);

-- ── Running invokes (v19) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS running_invokes (
    id             TEXT PRIMARY KEY,
    actor_id       TEXT NOT NULL REFERENCES actors(id),
    invoke_id      TEXT NOT NULL,
    service_id     TEXT NOT NULL,
    started_at     INTEGER NOT NULL,
    timeout_at     INTEGER NOT NULL,
    correlation_id TEXT NOT NULL,
    idempotent     INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'running'
                   CHECK(status IN ('running','done','failed'))
);

CREATE INDEX IF NOT EXISTS idx_running_invokes_actor ON running_invokes(actor_id);

-- ── Action jobs (v20) ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS action_jobs (
    id            TEXT PRIMARY KEY,
    actor_id      TEXT NOT NULL REFERENCES actors(id),
    action_name   TEXT NOT NULL,
    context_snap  BLOB,
    event_snap    BLOB,
    retry_count   INTEGER NOT NULL DEFAULT 0,
    max_retries   INTEGER NOT NULL DEFAULT 3,
    next_retry_at INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','running','done','failed')),
    created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_jobs_pending
  ON action_jobs(status, next_retry_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_action_jobs_actor ON action_jobs(actor_id);

-- ── Migration notifications (v21) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS migration_notifications (
    id                 TEXT PRIMARY KEY,
    actor_id           TEXT NOT NULL,
    from_definition_id TEXT NOT NULL,
    to_definition_id   TEXT NOT NULL,
    created_at         INTEGER NOT NULL,
    consumed_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_migration_notifs_pending
  ON migration_notifications(consumed_at) WHERE consumed_at IS NULL;

-- ── Actor archives ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS actor_archives (
    actor_id     TEXT PRIMARY KEY,
    machine_id   TEXT,
    archived_at  INTEGER NOT NULL,
    file_path    TEXT NOT NULL,
    state_value  TEXT,
    definition_id TEXT
);

-- ── Seed all migration versions so none re-run on a fresh database ─────────────
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES  (1, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES  (2, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES  (3, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES  (4, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES  (5, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES  (6, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES  (7, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES  (8, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES  (9, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (10, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (11, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (12, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (13, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (14, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (15, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (16, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (17, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (18, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (19, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (20, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (21, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (22, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (23, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (24, unixepoch());
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (25, unixepoch());
