-- 008 — registry epoch (fencing token for routing visibility).
-- Every deployment increments the epoch after its change-point row is committed. A server
-- may route an event only if its routing registry was synced at an epoch at least as new
-- as the one it reads at the start of the event, so a unit never routes without a
-- deployment that committed before it started — whatever the servers' clocks do.
CREATE TABLE IF NOT EXISTS registry_epoch (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  epoch BIGINT  NOT NULL
);
INSERT INTO registry_epoch (id, epoch) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
