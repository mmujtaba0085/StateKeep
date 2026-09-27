-- 006_spawn_keys.sql — spawn idempotency keys: a client that retries POST /v1/actors
-- after a lost answer gets the actor its first attempt created, not a second one.
CREATE TABLE IF NOT EXISTS spawn_keys (
  key        TEXT PRIMARY KEY,
  actor_id   TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
