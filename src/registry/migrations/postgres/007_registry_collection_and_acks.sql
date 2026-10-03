-- 007 — registry collection and cluster registry acknowledgements.
-- collected_at: a change-point below its family's collection frontier (no live actor can
--   reach it any more) is marked collected and is not registered again.
-- cluster_nodes.cp_low / par_low: every change-point row with an id at or below these is
--   registered in that server's routing registry; cp_seen / par_seen list the ids above
--   them that are registered too. A deployment waits for every live server
--   to acknowledge its row (or for the registry lease to run out) before it is committed.
ALTER TABLE changepoints     ADD COLUMN IF NOT EXISTS collected_at BIGINT;
ALTER TABLE par_changepoints ADD COLUMN IF NOT EXISTS collected_at BIGINT;
ALTER TABLE cluster_nodes    ADD COLUMN IF NOT EXISTS cp_low  BIGINT NOT NULL DEFAULT 0;
ALTER TABLE cluster_nodes    ADD COLUMN IF NOT EXISTS par_low BIGINT NOT NULL DEFAULT 0;
ALTER TABLE cluster_nodes    ADD COLUMN IF NOT EXISTS cp_seen  TEXT;
ALTER TABLE cluster_nodes    ADD COLUMN IF NOT EXISTS par_seen TEXT;
