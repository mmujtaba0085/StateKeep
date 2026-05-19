import { getDb } from './db.js';

const NOW = () => Date.now();

/** Returns the highest t_star ever registered — used to seed the engine clock on restart. */
export function getMaxTStar() {
  const db  = getDb();
  const row = db.prepare(`SELECT MAX(t_star) as max_t FROM changepoints`).get();
  const parRow = db.prepare(`SELECT MAX(t_star) as max_t FROM par_changepoints`).get();
  return Math.max(row?.max_t ?? 0, parRow?.max_t ?? 0);
}

/**
 * Returns the child definition ID if there is a wildcard (prefix_hash='0') changepoint
 * for `definitionId` that was registered AFTER `logicalStartTick`.
 * Used by the inline migration check to handle wildcard deployments without calling the
 * C engine (which performs exact prefix matching and cannot match non-zero fingerprints
 * against a 0 prefix_hash).
 */
export function getWildcardChildDef(definitionId, logicalStartTick) {
  const db = getDb();
  const cp = db.prepare(`
    SELECT cp.child_def_id
    FROM changepoints cp
    JOIN definitions d ON d.id = cp.child_def_id
    WHERE d.parent_id = ?
      AND cp.prefix_hash = '0'
      AND cp.t_star > ?
    ORDER BY cp.t_star DESC
    LIMIT 1
  `).get(definitionId, logicalStartTick ?? 0);
  return cp?.child_def_id ?? null;
}

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

// ── Parallel changepoints ─────────────────────────────────────────────────────

export function insertParChangepoint({ orgId, tStar, regionHashesHexArr, refinement, childDefId }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO par_changepoints (org_id, t_star, region_hashes, refinement, child_def_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(orgId, tStar, JSON.stringify(regionHashesHexArr), refinement ?? 0, childDefId, NOW());
}

export function loadParChangepointsAfter(afterId) {
  const db = getDb();
  return db.prepare(
    'SELECT id, t_star, region_hashes, refinement, child_def_id FROM par_changepoints WHERE id > ? ORDER BY id ASC'
  ).all(afterId);
}
