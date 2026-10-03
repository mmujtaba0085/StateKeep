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

/**
 * The highest logical tick anything has used: deployments and actors' start ticks. A
 * restarted server resumes its clock after this, so a new deployment is always later
 * than every actor that already exists. (last_event_tick is not used, and values that
 * look like wall-clock times are ignored: some paths store Date.now() where no engine
 * clock was available, and those are not logical ticks.)
 */
export async function getMaxKnownTick() {
  const maxT = await getMaxTStar();
  const sql = `SELECT MAX(logical_start_tick) AS a FROM actors WHERE logical_start_tick < 1000000000`;
  let r;
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    r = await queryOne(sql);
  } else {
    r = getDb().prepare(sql).get();
  }
  return Math.max(maxT, Number(r?.a ?? 0));
}

/**
 * The APV scalar rule, restricted to one workflow family: the change-point with the
 * smallest t* >= logicalTime whose prefix is the actor's fingerprint, unless a wildcard
 * (prefix 0) one is strictly earlier. The engine's registry is global — its answer can
 * be another family's change-point that happens to come first, which the caller must
 * discard; this finds the one that actually applies.
 */
export async function findFamilyChangepoint(definitionId, prefixDecimal, logicalTime) {
  const sql = `SELECT cp.child_def_id AS child, cp.t_star AS t, cp.prefix_hash AS p
    FROM changepoints cp JOIN definitions d ON d.id = cp.child_def_id
    WHERE d.machine_id = (SELECT machine_id FROM definitions WHERE id = $1)
      AND cp.t_star >= $2 AND cp.prefix_hash IN ($3, '0')
    ORDER BY cp.t_star ASC`;
  const args = [definitionId, Number(logicalTime), String(prefixDecimal)];
  let rows;
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    rows = await queryAll(sql, args);
  } else {
    rows = getDb().prepare(sql.replace(/\$\d+/g, '?')).all(...args);
  }
  const exact = rows.find((r) => r.p === String(prefixDecimal) && String(prefixDecimal) !== '0');
  const wild  = rows.find((r) => r.p === '0');
  if (exact && (!wild || Number(wild.t) >= Number(exact.t))) return exact.child;
  return wild?.child ?? null;
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

/** Returns the new row's id. */
export async function insertChangepoint({ tStar, prefixHash, refinement, childDefId }) {
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    const r = await queryOne(
      `INSERT INTO changepoints (t_star, prefix_hash, refinement, child_def_id, created_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tStar, String(prefixHash), refinement ?? 0, childDefId, NOW()]
    );
    return Number(r.id);
  }
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO changepoints (t_star, prefix_hash, refinement, child_def_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tStar, String(prefixHash), refinement ?? 0, childDefId, NOW());
  return Number(r.lastInsertRowid);
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
      `SELECT cp.id, cp.t_star, cp.prefix_hash, cp.refinement, cp.child_def_id, cp.collected_at, d.machine_id
         FROM changepoints cp LEFT JOIN definitions d ON d.id = cp.child_def_id
        WHERE cp.id>$1 ORDER BY cp.id ASC`,
      [afterId]
    );
  }
  const db = getDb();
  return db.prepare(`SELECT cp.id, cp.t_star, cp.prefix_hash, cp.refinement, cp.child_def_id, cp.collected_at, d.machine_id
    FROM changepoints cp LEFT JOIN definitions d ON d.id = cp.child_def_id
    WHERE cp.id > ? ORDER BY cp.id ASC`).all(afterId);
}

export async function insertParChangepoint({ tStar, regionHashesHexMap, regionHashesHexArr, refinement, childDefId }) {
  if (regionHashesHexMap && regionHashesHexArr) {
    throw new Error('insertParChangepoint accepts either regionHashesHexMap or deprecated regionHashesHexArr, not both');
  }
  const payload = regionHashesHexMap ?? regionHashesHexArr;
  if (!payload) throw new Error('insertParChangepoint requires region hashes');
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    const r = await queryOne(
      `INSERT INTO par_changepoints (t_star, region_hashes, refinement, child_def_id, created_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tStar, JSON.stringify(payload), refinement ?? 0, childDefId, NOW()]
    );
    return Number(r.id);
  }
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO par_changepoints (t_star, region_hashes, refinement, child_def_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tStar, JSON.stringify(payload), refinement ?? 0, childDefId, NOW());
  return Number(r.lastInsertRowid);
}

export async function loadParChangepointsAfter(afterId) {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    return queryAll(
      `SELECT cp.id, cp.t_star, cp.region_hashes, cp.refinement, cp.child_def_id, cp.collected_at, d.machine_id
         FROM par_changepoints cp LEFT JOIN definitions d ON d.id = cp.child_def_id
        WHERE cp.id>$1 ORDER BY cp.id ASC`,
      [afterId]
    );
  }
  const db = getDb();
  return db.prepare(
    `SELECT cp.id, cp.t_star, cp.region_hashes, cp.refinement, cp.child_def_id, cp.collected_at, d.machine_id
       FROM par_changepoints cp LEFT JOIN definitions d ON d.id = cp.child_def_id
      WHERE cp.id > ? ORDER BY cp.id ASC`
  ).all(afterId);
}

// ── Collection frontier ──────────────────────────────────────────────────────

/**
 * Per workflow family, the collection frontier Φ: the smallest logical time any actor
 * of the family that can still be routed may have — every actor that is not terminated
 * (active, stranded, archived: an archived actor can be restored) — and never more than
 * one past the family's newest deployment (new actors start there). A change-point at
 * t* < Φ can never apply again. Returns [{ machineId, frontier }].
 */
export async function familyFrontiers() {
  const actorsSql = `SELECT d.machine_id AS m,
      MIN(CASE WHEN a.logical_start_tick > d.deployed_at THEN a.logical_start_tick ELSE d.deployed_at + 1 END) AS phi
    FROM actors a JOIN definitions d ON d.id = a.definition_id
    WHERE a.status <> 'terminated' AND d.machine_id IS NOT NULL GROUP BY d.machine_id`;
  const defsSql = `SELECT machine_id AS m, MAX(deployed_at) + 1 AS phi FROM definitions
    WHERE machine_id IS NOT NULL GROUP BY machine_id`;
  // Deployment times FIRST, then actors: an actor spawned in between was dated (under the
  // family lock) no earlier than the deployments already read, so the frontier cannot
  // pass it; a deployment committed in between is later than the frontier.
  let a, d;
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    d = await queryAll(defsSql);
    a = await queryAll(actorsSql);
  } else {
    const db = getDb();
    d = db.prepare(defsSql).all(); a = db.prepare(actorsSql).all();
  }
  const byActors = new Map(a.map((r) => [r.m, Number(r.phi)]));
  return d.map((r) => ({
    machineId: r.m,
    frontier: Math.min(Number(r.phi), byActors.get(r.m) ?? Infinity),
  }));
}

/** Mark the family's change-points below the frontier collected. Returns the count. */
export async function markCollected(machineId, frontier) {
  const now = NOW();
  let n = 0;
  for (const t of ['changepoints', 'par_changepoints']) {
    const sql = `UPDATE ${t} SET collected_at = $1 WHERE collected_at IS NULL AND t_star < $2
      AND child_def_id IN (SELECT id FROM definitions WHERE machine_id = $3)`;
    if (isPostgres) {
      const { query } = await import('./db-postgres.js');
      const r = await query(sql, [now, frontier, machineId]);
      n += r.rowCount ?? 0;
    } else {
      n += getDb().prepare(sql.replace(/\$\d+/g, '?')).run(now, frontier, machineId).changes;
    }
  }
  return n;
}
