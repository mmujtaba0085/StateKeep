import { getDb, isPostgres } from './db.js';

const NOW = () => Date.now();

export async function getMaxTStar() {
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    const [r1, r2] = await Promise.all([
      queryOne(`SELECT MAX(t_star) as max_t FROM changepoints`),
      queryOne(`SELECT MAX(t_star) as max_t FROM par_changepoints`),
    ]);
    return Math.max(Number(r1?.max_t ?? 0), Number(r2?.max_t ?? 0));
  }
  const db     = getDb();
  const row    = db.prepare(`SELECT MAX(t_star) as max_t FROM changepoints`).get();
  const parRow = db.prepare(`SELECT MAX(t_star) as max_t FROM par_changepoints`).get();
  return Math.max(row?.max_t ?? 0, parRow?.max_t ?? 0);
}

export async function getWildcardChildDef(definitionId, logicalStartTick) {
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    const row = await queryOne(
      `SELECT cp.child_def_id
       FROM changepoints cp
       JOIN definitions d ON d.id = cp.child_def_id
       WHERE d.parent_id=$1 AND cp.prefix_hash='0' AND cp.t_star>$2
       ORDER BY cp.t_star DESC LIMIT 1`,
      [definitionId, logicalStartTick ?? 0]
    );
    return row?.child_def_id ?? null;
  }
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

export async function insertChangepoint({ tStar, prefixHash, refinement, childDefId }) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(
      `INSERT INTO changepoints (t_star, prefix_hash, refinement, child_def_id, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [tStar, String(prefixHash), refinement ?? 0, childDefId, NOW()]
    );
    return;
  }
  const db = getDb();
  db.prepare(`
    INSERT INTO changepoints (t_star, prefix_hash, refinement, child_def_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tStar, String(prefixHash), refinement ?? 0, childDefId, NOW());
}

export async function loadChangepoints() {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    return queryAll('SELECT id, t_star, prefix_hash, refinement, child_def_id FROM changepoints ORDER BY id ASC');
  }
  const db = getDb();
  return db.prepare('SELECT id, t_star, prefix_hash, refinement, child_def_id FROM changepoints ORDER BY id ASC').all();
}

export async function loadChangepointsAfter(afterId) {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    return queryAll(
      'SELECT id, t_star, prefix_hash, refinement, child_def_id FROM changepoints WHERE id>$1 ORDER BY id ASC',
      [afterId]
    );
  }
  const db = getDb();
  return db.prepare('SELECT id, t_star, prefix_hash, refinement, child_def_id FROM changepoints WHERE id > ? ORDER BY id ASC').all(afterId);
}

export async function insertParChangepoint({ tStar, regionHashesHexMap, regionHashesHexArr, refinement, childDefId }) {
  if (regionHashesHexMap && regionHashesHexArr) {
    throw new Error('insertParChangepoint accepts either regionHashesHexMap or deprecated regionHashesHexArr, not both');
  }
  const payload = regionHashesHexMap ?? regionHashesHexArr;
  if (!payload) throw new Error('insertParChangepoint requires region hashes');
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(
      `INSERT INTO par_changepoints (t_star, region_hashes, refinement, child_def_id, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [tStar, JSON.stringify(payload), refinement ?? 0, childDefId, NOW()]
    );
    return;
  }
  const db = getDb();
  db.prepare(`
    INSERT INTO par_changepoints (t_star, region_hashes, refinement, child_def_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tStar, JSON.stringify(payload), refinement ?? 0, childDefId, NOW());
}

export async function loadParChangepointsAfter(afterId) {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    return queryAll(
      'SELECT id, t_star, region_hashes, refinement, child_def_id FROM par_changepoints WHERE id>$1 ORDER BY id ASC',
      [afterId]
    );
  }
  const db = getDb();
  return db.prepare(
    'SELECT id, t_star, region_hashes, refinement, child_def_id FROM par_changepoints WHERE id > ? ORDER BY id ASC'
  ).all(afterId);
}
