-- 009 — stranding consent.
-- confirm_tokens: a deployment preview that would strand actors issues a one-time token,
--   stored here so it can be confirmed through any API server and survives restarts. It
--   records exactly which actors the operator is consenting to strand.
-- stranding_consents: after a confirmed deployment, which actors were consented for it, so
--   a stranding outside that set (an actor that changed state between the final check and
--   the commit) is reported instead of passing silently.
CREATE TABLE IF NOT EXISTS confirm_tokens (
  token           TEXT PRIMARY KEY,
  definition_id   TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  actor_ids       TEXT NOT NULL,
  expires_at      BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS stranding_consents (
  definition_id TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  PRIMARY KEY (definition_id, actor_id)
);
