-- 004_action_delivery.sql — action delivery guarantees (see docs/side-effects.md)
--   started_at  : an attempt was sent to the implementation (outcome unknown until it answers)
--   result_snap : the implementation's answer, kept until its follow-up event is delivered
--   outcome     : 'unknown' when a human must decide whether the side effect happened
ALTER TABLE action_jobs ADD COLUMN IF NOT EXISTS started_at  BIGINT;
ALTER TABLE action_jobs ADD COLUMN IF NOT EXISTS outcome     TEXT;
ALTER TABLE action_jobs ADD COLUMN IF NOT EXISTS result_snap BYTEA;
CREATE INDEX IF NOT EXISTS idx_action_jobs_outcome ON action_jobs (outcome) WHERE outcome IS NOT NULL;
