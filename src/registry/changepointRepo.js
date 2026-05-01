import { getDb } from './db.js';

const NOW = () => Date.now();

export function insertChangepoint({ orgId, tStar, prefixHash, refinement, childDefId }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO changepoints (org_id, t_star, prefix_hash, refinement, child_def_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(orgId, tStar, String(prefixHash), refinement ?? 0, childDefId, NOW());
}

export function loadChangepoints() {
  const db = getDb();
  return db.prepare('SELECT id, t_star, prefix_hash, refinement, child_def_id FROM changepoints ORDER BY id ASC').all();
}

/** Incremental load: only rows with id > afterId. Used by the worker poll loop. */
export function loadChangepointsAfter(afterId) {
  const db = getDb();
  return db.prepare('SELECT id, t_star, prefix_hash, refinement, child_def_id FROM changepoints WHERE id > ? ORDER BY id ASC').all(afterId);
}
