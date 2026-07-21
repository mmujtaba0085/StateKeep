-- StateKeep — Postgres Initial Schema v25
-- Applied once by db-postgres.js bootstrapSchema() on first connection.
-- No org_id columns, no orgs table, no api_keys table.

-- ── Schema version tracking ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at BIGINT NOT NULL
);

-- ── Machine definitions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS definitions (
    id              TEXT PRIMARY KEY,
    parent_id       TEXT REFERENCES definitions(id),
    machine_id      TEXT,
    definition_json BYTEA NOT NULL,
    compiled_json   BYTEA,
    deployed_at     BIGINT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active','deprecated','pruned')),
    created_at      BIGINT
);

CREATE INDEX IF NOT EXISTS idx_definitions_parent  ON definitions(parent_id);
CREATE INDEX IF NOT EXISTS idx_definitions_status  ON definitions(status);
CREATE INDEX IF NOT EXISTS idx_definitions_machine ON definitions(machine_id);

-- ── Actors ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS actors (
    id                   TEXT PRIMARY KEY,
    definition_id        TEXT NOT NULL REFERENCES definitions(id),
    state_value          TEXT,
    context_json         BYTEA,
    history_fingerprint  TEXT NOT NULL DEFAULT '0',
    region_fingerprints  TEXT,
    state_entry_id       BIGINT NOT NULL DEFAULT 0,
    logical_start_tick   BIGINT NOT NULL DEFAULT 0,
    last_event_tick      BIGINT,
    status               TEXT NOT NULL DEFAULT 'active'
                         CHECK(status IN ('active','migrating','terminated','archived','needs_rescue')),
    created_at           BIGINT NOT NULL,
    updated_at           BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_actors_definition ON actors(definition_id);
CREATE INDEX IF NOT EXISTS idx_actors_status     ON actors(status);
CREATE INDEX IF NOT EXISTS idx_actors_updated    ON actors(updated_at);
CREATE INDEX IF NOT EXISTS idx_actors_rescue     ON actors(status) WHERE status = 'needs_rescue';
CREATE INDEX IF NOT EXISTS idx_actors_def        ON actors(definition_id);

-- ── Event log ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
    id              BIGSERIAL PRIMARY KEY,
    actor_id        TEXT NOT NULL REFERENCES actors(id),
    event_type      TEXT NOT NULL,
    event_payload   BYTEA,
    idempotency_key TEXT,
    tick            BIGINT NOT NULL,
    processed_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_actor        ON events(actor_id);
CREATE INDEX IF NOT EXISTS idx_events_processed_at ON events(processed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem ON events(actor_id, idempotency_key)
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
    completed_at     BIGINT
);

CREATE INDEX IF NOT EXISTS idx_deployments_defid  ON deployments(definition_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);

-- ── Migration jobs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS migration_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id   TEXT NOT NULL REFERENCES deployments(id),
    actor_id        TEXT NOT NULL REFERENCES actors(id),
    target_def_id   TEXT NOT NULL REFERENCES definitions(id),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','processing','done','failed')),
    error           TEXT,
    created_at      BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status     ON migration_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_deployment ON migration_jobs(deployment_id);
CREATE INDEX IF NOT EXISTS idx_jobs_actor      ON migration_jobs(actor_id);

-- ── Migration decision log ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS migration_decisions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id            TEXT NOT NULL REFERENCES actors(id),
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

-- ── Changepoints ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS changepoints (
    id           BIGSERIAL PRIMARY KEY,
    t_star       BIGINT NOT NULL,
    prefix_hash  TEXT NOT NULL,
    refinement   BIGINT NOT NULL DEFAULT 0,
    child_def_id TEXT NOT NULL,
    created_at   BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_changepoints_unique
  ON changepoints(t_star, prefix_hash, refinement);

-- ── Parallel changepoints ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS par_changepoints (
    id            BIGSERIAL PRIMARY KEY,
    t_star        BIGINT NOT NULL,
    region_hashes JSONB NOT NULL,
    refinement    BIGINT NOT NULL DEFAULT 0,
    child_def_id  TEXT NOT NULL UNIQUE,
    created_at    BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

-- ── Scheduled events ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id    TEXT NOT NULL REFERENCES actors(id),
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

-- ── Webhooks ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhooks (
    id            TEXT PRIMARY KEY,
    url           TEXT NOT NULL,
    secret        BYTEA NOT NULL,
    events        JSONB NOT NULL,
    active        BOOLEAN NOT NULL DEFAULT true,
    created_at    BIGINT NOT NULL,
    last_fired_at BIGINT,
    failure_count INTEGER NOT NULL DEFAULT 0
);

-- ── Webhook delivery log ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id   TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_type   TEXT NOT NULL,
    payload      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending','delivered','failed')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    created_at   BIGINT NOT NULL,
    delivered_at BIGINT,
    error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON webhook_deliveries(status) WHERE status = 'pending';

-- ── Actor archives ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS actor_archives (
    id            TEXT PRIMARY KEY,
    definition_id TEXT,
    final_state   TEXT,
    context_json  BYTEA,
    terminated_at BIGINT,
    created_at    BIGINT NOT NULL
);

-- ── Worker heartbeats ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker_heartbeats (
    worker_type  TEXT PRIMARY KEY,
    last_beat    BIGINT NOT NULL
);

-- ── Metrics snapshots ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS metrics_snapshots (
    id          BIGSERIAL PRIMARY KEY,
    snapshot    JSONB NOT NULL,
    captured_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metrics_captured ON metrics_snapshots(captured_at);

-- ── Running invokes ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS running_invokes (
    id         TEXT PRIMARY KEY,
    actor_id   TEXT NOT NULL REFERENCES actors(id),
    service_id TEXT NOT NULL,
    started_at BIGINT NOT NULL,
    idempotent BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_running_invokes_actor ON running_invokes(actor_id);

-- ── Action jobs ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS action_jobs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id     TEXT NOT NULL REFERENCES actors(id),
    action_name  TEXT NOT NULL,
    context_snap BYTEA,
    event_snap   BYTEA,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending','running','done','failed')),
    retry_count  INTEGER NOT NULL DEFAULT 0,
    max_retries  INTEGER NOT NULL DEFAULT 3,
    run_after    BIGINT NOT NULL,
    created_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_jobs_pending
  ON action_jobs(status, run_after) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_action_jobs_actor ON action_jobs(actor_id);

-- ── Migration notifications ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS migration_notifications (
    id          BIGSERIAL PRIMARY KEY,
    actor_id    TEXT NOT NULL,
    notified_at BIGINT NOT NULL
);

-- ── Seed schema version ────────────────────────────────────────────────────────
INSERT INTO schema_migrations (version, applied_at)
VALUES (25, EXTRACT(EPOCH FROM NOW())::BIGINT)
ON CONFLICT DO NOTHING;
