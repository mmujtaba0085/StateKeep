-- 005_deploy_clock.sql — one deployment clock for every API server sharing the database.
-- Each server's APV engine clock is in-process; with several servers two deployments
-- could get the same t* (unique-index violation) or out-of-order t*s. Deployments now
-- take t* from this sequence (see src/registry/deployClock.js).
CREATE SEQUENCE IF NOT EXISTS statekeep_deploy_clock;
SELECT setval('statekeep_deploy_clock',
  GREATEST((SELECT COALESCE(MAX(t_star), 0) FROM changepoints),
           (SELECT COALESCE(MAX(deployed_at), 0) FROM definitions), 1));
