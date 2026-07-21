-- StateKeep — Postgres Schema v1
-- Applied once by db-postgres.js bootstrapSchema() on first connection.

-- ── Organisations ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orgs (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

INSERT INTO orgs (id, name, created_at)
VALUES ('default', 'Default Org', EXTRACT(EPOCH FROM NOW())::BIGINT)
ON CONFLICT DO NOTHING;

-- ── Machine definitions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS definitions (
    id              TEXT PRIMARY KEY,
    parent_id       TEXT REFERENCES definitions(id),
    machine_id      TEXT,
    definition_json BYTEA NOT NULL,
    deployed_at     BIGINT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active','deprecated','pruned')),
    org_id          TEXT NOT NULL DEFAULT 'default',
    created_at      BIGINT
);

CREATE INDEX IF NOT EXISTS idx_definitions_parent  ON definitions(parent_id);
CREATE INDEX IF NOT EXISTS idx_definitions_status  ON definitions(status);
CREATE INDEX IF NOT EXISTS idx_definitions_machine ON definitions(machine_id);
CREATE INDEX IF NOT EXISTS idx_definitions_org     ON definitions(org_id);

-- ── Actors ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS actors (
    id                   TEXT PRIMARY KEY,
    definition_id        TEXT NOT NULL REFERENCES definitions(id),
    state_value          TEXT,
    context_json         BYTEA,
    logical_start_tick   BIGINT NOT NULL DEFAULT 0,
    history_fingerprint  TEXT NOT NULL DEFAULT '0',
    region_fingerprints  TEXT,
    last_event_tick      BIGINT,
    status               TEXT NOT NULL DEFAULT 'active'
                         CHECK(status IN ('active','migrating','terminated','archived','needs_rescue')),
    created_at           BIGINT NOT NULL,
    updated_at           BIGINT NOT NULL,
    org_id               TEXT NOT NULL DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_actors_definition ON actors(definition_id);
CREATE INDEX IF NOT EXISTS idx_actors_status     ON actors(status);
CREATE INDEX IF NOT EXISTS idx_actors_updated    ON actors(updated_at);
CREATE INDEX IF NOT EXISTS idx_actors_rescue     ON actors(status) WHERE status = 'needs_rescue';
CREATE INDEX IF NOT EXISTS idx_actors_org        ON actors(org_id);
CREATE INDEX IF NOT EXISTS idx_actors_def        ON actors(definition_id, org_id);

-- ── Event log ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
    id              BIGSERIAL PRIMARY KEY,
    actor_id        TEXT NOT NULL REFERENCES actors(id),
    org_id          TEXT NOT NULL DEFAULT 'default',
    event_type      TEXT NOT NULL,
    event_payload   BYTEA,
    tick            BIGINT NOT NULL,
    processed_at    BIGINT NOT NULL,
    idempotency_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_actor        ON events(actor_id);
CREATE INDEX IF NOT EXISTS idx_events_processed_at ON events(processed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem ON events(actor_id, org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── Deployments ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deployments (
    id               TEXT PRIMARY KEY,
    definition_id    TEXT NOT NULL REFERENCES definitions(id),
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','migrating','complete','failed')),
    affected_actors  INTEGER NOT NULL DEFAULT 0,
    migrated_count   INTEGER NOT NULL DEFAULT 0,
    failed_count     INTEGER NOT NULL DEFAULT 0,
    started_at       BIGINT,
    completed_at     BIGINT,
    org_id           TEXT NOT NULL DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_deployments_defid  ON deployments(definition_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);

-- ── Migration jobs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS migration_jobs (
    id              BIGSERIAL PRIMARY KEY,
    deployment_id   TEXT NOT NULL REFERENCES deployments(id),
    actor_id        TEXT NOT NULL REFERENCES actors(id),
    target_def_id   TEXT NOT NULL REFERENCES definitions(id),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','processing','done','failed')),
    error_message   TEXT,
    created_at      BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL,
    org_id          TEXT NOT NULL DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_jobs_status     ON migration_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_deployment ON migration_jobs(deployment_id);
CREATE INDEX IF NOT EXISTS idx_jobs_actor      ON migration_jobs(actor_id);
CREATE INDEX IF NOT EXISTS idx_jobs_org        ON migration_jobs(org_id);

-- ── API keys ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
    key_hash    TEXT PRIMARY KEY,
    key_id      TEXT,
    label       TEXT NOT NULL,
    tier        TEXT NOT NULL DEFAULT 'free'
                CHECK(tier IN ('free','pro','enterprise')),
    created_at  BIGINT NOT NULL,
    org_id      TEXT NOT NULL DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_id ON api_keys(key_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_org    ON api_keys(org_id);

-- ── Metrics snapshots ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS metrics_snapshots (
    id                      BIGSERIAL PRIMARY KEY,
    captured_at             BIGINT NOT NULL,
    active_actors           INTEGER NOT NULL DEFAULT 0,
    migrating_actors        INTEGER NOT NULL DEFAULT 0,
    archived_actors         INTEGER NOT NULL DEFAULT 0,
    definitions_count       INTEGER NOT NULL DEFAULT 0,
    pending_jobs            INTEGER NOT NULL DEFAULT 0,
    ffi_calls_total         INTEGER NOT NULL DEFAULT 0,
    ffi_latency_p50_ms      REAL NOT NULL DEFAULT 0,
    ffi_latency_p99_ms      REAL NOT NULL DEFAULT 0,
    api_requests_total      INTEGER NOT NULL DEFAULT 0,
    api_latency_p50_ms      REAL NOT NULL DEFAULT 0,
    api_latency_p95_ms      REAL NOT NULL DEFAULT 0,
    api_latency_p99_ms      REAL NOT NULL DEFAULT 0,
    wal_size_bytes          BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_metrics_captured ON metrics_snapshots(captured_at);

-- ── Migration decision log ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS migration_decisions (
    id                  BIGSERIAL PRIMARY KEY,
    actor_id            TEXT NOT NULL REFERENCES actors(id),
    org_id              TEXT NOT NULL DEFAULT 'default',
    deployment_id       TEXT REFERENCES deployments(id),
    trigger             TEXT NOT NULL
                        CHECK(trigger IN ('inline_event','batch_worker','preview')),
    evaluated_at        BIGINT NOT NULL,
    decision            TEXT NOT NULL
                        CHECK(decision IN ('migrated','stayed','failed','cancelled')),
    reason              TEXT NOT NULL,
    from_definition_id  TEXT,
    to_definition_id    TEXT,
    actor_fingerprint   TEXT NOT NULL,
    prefix_hash         TEXT NOT NULL,
    created_at          BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_actor      ON migration_decisions(actor_id);
CREATE INDEX IF NOT EXISTS idx_decisions_deployment ON migration_decisions(deployment_id);
CREATE INDEX IF NOT EXISTS idx_decisions_decision   ON migration_decisions(decision);
CREATE INDEX IF NOT EXISTS idx_decisions_evaluated  ON migration_decisions(evaluated_at);
CREATE INDEX IF NOT EXISTS idx_decisions_org        ON migration_decisions(org_id);

-- ── Scheduled events ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_events (
    id          BIGSERIAL PRIMARY KEY,
    actor_id    TEXT NOT NULL REFERENCES actors(id),
    org_id      TEXT NOT NULL DEFAULT 'default',
    event_type  TEXT NOT NULL,
    payload_enc BYTEA,
    fire_at     BIGINT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','fired','failed','cancelled')),
    fired_at    BIGINT,
    error       TEXT,
    created_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sched_actor   ON scheduled_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_sched_fire_at ON scheduled_events(fire_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_sched_org     ON scheduled_events(org_id);

-- ── Worker heartbeats ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker_heartbeats (
    worker_id    TEXT PRIMARY KEY,
    worker_type  TEXT NOT NULL
                 CHECK(worker_type IN ('migrate','gc','snapshot','metrics','scheduler','webhook')),
    last_beat    BIGINT NOT NULL,
    started_at   BIGINT NOT NULL,
    pid          INTEGER NOT NULL
);

-- ── Webhooks ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhooks (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL,
    url           TEXT NOT NULL,
    secret        BYTEA NOT NULL,
    events        TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    BIGINT NOT NULL,
    last_fired_at BIGINT,
    failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(org_id);

-- ── Webhook delivery log ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id            TEXT PRIMARY KEY,
    webhook_id    TEXT NOT NULL REFERENCES webhooks(id),
    org_id        TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    payload       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','delivered','failed')),
    attempts      INTEGER NOT NULL DEFAULT 0,
    next_retry_at BIGINT,
    last_attempt  BIGINT,
    response_code INTEGER,
    error         TEXT,
    created_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON webhook_deliveries(status) WHERE status = 'pending';

-- ── Changepoints ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS changepoints (
    id           BIGSERIAL PRIMARY KEY,
    org_id       TEXT NOT NULL,
    t_star       BIGINT NOT NULL,
    prefix_hash  TEXT NOT NULL,
    refinement   BIGINT NOT NULL DEFAULT 0,
    child_def_id TEXT NOT NULL,
    created_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_changepoints_org ON changepoints(org_id);

-- ── Parallel changepoints ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS par_changepoints (
    id            BIGSERIAL PRIMARY KEY,
    org_id        TEXT NOT NULL,
    t_star        BIGINT NOT NULL,
    region_hashes TEXT NOT NULL,
    refinement    BIGINT NOT NULL DEFAULT 0,
    child_def_id  TEXT NOT NULL,
    created_at    BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_par_cp_org ON par_changepoints(org_id, t_star);
