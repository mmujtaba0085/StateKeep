-- 002_align_with_sqlite.sql
--
-- The Postgres schema was created once (001) and never followed the 24 SQLite
-- migrations that came after it. The code queries the newer columns on both
-- backends, so on Postgres these features failed at runtime:
--   migration notifications (consumed_at), durable action retries (next_retry_at),
--   invoke recovery (status), scheduled-event retries / dead-letter (retry_count),
--   worker health (pid / worker_id), metrics snapshots, migration job errors.
-- This migration brings every table to the column set the code uses (matching the
-- current SQLite schema). Idempotent: safe to re-run.

-- ── worker_heartbeats: one row per worker process (was one per worker type) ───
-- Transient liveness data — recreated rather than migrated.
DROP TABLE IF EXISTS worker_heartbeats;
CREATE TABLE worker_heartbeats (
  worker_id   TEXT   PRIMARY KEY,
  worker_type TEXT   NOT NULL,
  last_beat   BIGINT NOT NULL,
  started_at  BIGINT NOT NULL,
  pid         INTEGER NOT NULL
);

-- ── migration_notifications: text ids, from/to definition, consumed_at ────────
-- Never usable on Postgres before (every read failed on consumed_at) → recreate.
DROP TABLE IF EXISTS migration_notifications;
CREATE TABLE migration_notifications (
  id                 TEXT   PRIMARY KEY,
  actor_id           TEXT   NOT NULL,
  from_definition_id TEXT   NOT NULL,
  to_definition_id   TEXT   NOT NULL,
  created_at         BIGINT NOT NULL,
  consumed_at        BIGINT
);
CREATE INDEX IF NOT EXISTS idx_migration_notifs_pending
  ON migration_notifications (consumed_at) WHERE consumed_at IS NULL;

-- ── metrics_snapshots: flat columns (was a single jsonb blob no code wrote) ───
DROP TABLE IF EXISTS metrics_snapshots;
CREATE TABLE metrics_snapshots (
  id                 BIGSERIAL PRIMARY KEY,
  captured_at        BIGINT,
  active_actors      INTEGER,
  migrating_actors   INTEGER,
  archived_actors    INTEGER,
  definitions_count  INTEGER,
  pending_jobs       INTEGER,
  ffi_calls_total    BIGINT,
  ffi_latency_p50_ms DOUBLE PRECISION,
  ffi_latency_p99_ms DOUBLE PRECISION,
  api_requests_total BIGINT,
  api_latency_p50_ms DOUBLE PRECISION,
  api_latency_p95_ms DOUBLE PRECISION,
  api_latency_p99_ms DOUBLE PRECISION,
  wal_size_bytes     BIGINT
);
CREATE INDEX IF NOT EXISTS idx_metrics_captured ON metrics_snapshots (captured_at);

-- ── running_invokes ───────────────────────────────────────────────────────────
ALTER TABLE running_invokes ADD COLUMN IF NOT EXISTS invoke_id      TEXT;
ALTER TABLE running_invokes ADD COLUMN IF NOT EXISTS timeout_at     BIGINT;
ALTER TABLE running_invokes ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE running_invokes ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'running';
CREATE INDEX IF NOT EXISTS idx_running_invokes_actor ON running_invokes (actor_id);

-- ── scheduled_events: retry bookkeeping for the scheduler / dead-letter ───────
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS retry_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS max_retries   INTEGER NOT NULL DEFAULT 3;
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS next_retry_at BIGINT;

-- ── action_jobs: code uses next_retry_at; 001 had run_after NOT NULL, which no
--    INSERT supplies — every durable-action insert failed. Keep the data. ───────
ALTER TABLE action_jobs ADD COLUMN IF NOT EXISTS next_retry_at BIGINT;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'action_jobs' AND column_name = 'run_after') THEN
    UPDATE action_jobs SET next_retry_at = run_after WHERE next_retry_at IS NULL;
    ALTER TABLE action_jobs DROP COLUMN run_after;
  END IF;
END $$;
UPDATE action_jobs SET next_retry_at = created_at WHERE next_retry_at IS NULL;
ALTER TABLE action_jobs ALTER COLUMN next_retry_at SET NOT NULL;
ALTER TABLE action_jobs ALTER COLUMN status        SET DEFAULT 'pending';
ALTER TABLE action_jobs ALTER COLUMN retry_count   SET DEFAULT 0;
ALTER TABLE action_jobs ALTER COLUMN max_retries   SET DEFAULT 3;
CREATE INDEX IF NOT EXISTS idx_action_jobs_pending ON action_jobs (status, next_retry_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_action_jobs_actor   ON action_jobs (actor_id);

-- ── webhook_deliveries ────────────────────────────────────────────────────────
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS next_retry_at BIGINT;

-- ── migration_jobs: code writes error_message ─────────────────────────────────
ALTER TABLE migration_jobs ADD COLUMN IF NOT EXISTS error_message TEXT;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'migration_jobs' AND column_name = 'error') THEN
    UPDATE migration_jobs SET error_message = error WHERE error_message IS NULL;
  END IF;
END $$;
