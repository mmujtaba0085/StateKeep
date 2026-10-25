-- 010 — ownership generations (fencing tokens). Every claim or takeover increments gen;
-- the write buffer commits an owner's writes only while gen is still the one it claimed.
ALTER TABLE actor_owners ADD COLUMN IF NOT EXISTS gen BIGINT NOT NULL DEFAULT 1;
