-- 003_cluster.sql — multi-server mode (STATEKEEP_CLUSTER=true, Postgres only)
--
-- cluster_nodes : one row per API server, heartbeated every second
-- actor_owners  : which server owns (caches and writes) each actor. Ownership moves only
--                 when the owner's heartbeat has expired (or on explicit handover).

CREATE TABLE IF NOT EXISTS cluster_nodes (
  node_id    TEXT   PRIMARY KEY,
  url        TEXT   NOT NULL,
  started_at BIGINT NOT NULL,
  last_seen  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS actor_owners (
  actor_id   TEXT   PRIMARY KEY,
  node_id    TEXT   NOT NULL,
  claimed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actor_owners_node ON actor_owners (node_id);
