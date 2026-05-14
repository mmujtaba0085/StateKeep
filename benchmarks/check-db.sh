#!/usr/bin/env bash
export PATH=/home/moham/.nvm/versions/node/v22.22.2/bin:/usr/bin:/bin:$PATH
node -e "
const db = require('/mnt/d/Project/StateKeep-fixed/node_modules/better-sqlite3')('/tmp/sk-live.db');
try {
  const deps = db.prepare('SELECT id, status, affected_actors, migrated_count, failed_count FROM deployments').all();
  console.log('DEPLOYMENTS:', JSON.stringify(deps, null, 2));
  const jobs = db.prepare('SELECT id, status, error_message FROM migration_jobs LIMIT 20').all();
  console.log('JOBS:', JSON.stringify(jobs, null, 2));
} catch(e) { console.error('DB error:', e.message); }
db.close();
"
