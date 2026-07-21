/**
 * src/registry/scheduledEventRepo.js
 *
 * CRUD helpers for the scheduled_events table.
 * All writes use prepared-statement caching for efficiency.
 */

import { getDb, encrypt, decrypt, isPostgres } from './db.js';

let stmts = null;

function getStmts() {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    insert: db.prepare(`
      INSERT INTO scheduled_events (actor_id, event_type, payload_enc, fire_at, status, created_at)
      VALUES (@actorId, @eventType, @payloadEnc, @fireAt, 'pending', @createdAt)
    `),
    findDue: db.prepare(`
      SELECT * FROM scheduled_events
      WHERE status = 'pending'
        AND fire_at <= ?
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY fire_at ASC
      LIMIT 500
    `),
    markFired: db.prepare(`
      UPDATE scheduled_events
      SET status = 'fired', fired_at = ?
      WHERE id = ? AND status = 'pending'
    `),
    markFailed: db.prepare(`
      UPDATE scheduled_events
      SET status = 'failed', error = ?
      WHERE id = ? AND status = 'pending'
    `),
    markDispatchFailed: db.prepare(`
      UPDATE scheduled_events
      SET status = 'failed', error = ?
      WHERE id = ? AND status = 'fired'
    `),
    scheduleRetry: db.prepare(`
      UPDATE scheduled_events
      SET status = 'pending', retry_count = retry_count + 1, next_retry_at = ?, error = ?
      WHERE id = ?
    `),
    markRetryExhausted: db.prepare(`
      UPDATE scheduled_events
      SET status = 'failed', error = ?
      WHERE id = ?
    `),
    findDeadLetter: db.prepare(`
      SELECT * FROM scheduled_events
      WHERE status = 'failed' AND retry_count >= max_retries
      ORDER BY fire_at DESC
      LIMIT ?
    `),
    cancel: db.prepare(`
      UPDATE scheduled_events
      SET status = 'cancelled'
      WHERE id = ? AND actor_id = ? AND status = 'pending'
    `),
    findByActor: db.prepare(`
      SELECT * FROM scheduled_events
      WHERE actor_id = ?
      ORDER BY fire_at ASC
    `),
    findByActorAll: db.prepare(`
      SELECT * FROM scheduled_events
      WHERE actor_id = ?
      ORDER BY fire_at ASC
    `),
    findByActorStatus: db.prepare(`
      SELECT * FROM scheduled_events
      WHERE actor_id = ? AND status = ?
      ORDER BY fire_at ASC
    `),
    findById: db.prepare(`
      SELECT * FROM scheduled_events WHERE id = ?
    `),
  };
  return stmts;
}

export async function createScheduledEvent({ actorId, eventType, payload, fireAt }) {
  const payloadEnc = payload != null ? encrypt(JSON.stringify(payload)) : null;
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    const row = await queryOne(
      `INSERT INTO scheduled_events (actor_id, event_type, payload_enc, fire_at, status, created_at)
       VALUES ($1,$2,$3,$4,'pending',$5) RETURNING id`,
      [actorId, eventType, payloadEnc, fireAt, Date.now()]
    );
    return row?.id;
  }
  const s = getStmts();
  const info = s.insert.run({ actorId, eventType, payloadEnc, fireAt, createdAt: Date.now() });
  return info.lastInsertRowid;
}

export async function findDueEvents(nowMs) {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    return (await queryAll(
      `SELECT * FROM scheduled_events WHERE status='pending' AND fire_at<=$1 AND (next_retry_at IS NULL OR next_retry_at<=$2) ORDER BY fire_at ASC LIMIT 500`,
      [nowMs, nowMs]
    )).map(decodeRow);
  }
  return getStmts().findDue.all(nowMs, nowMs).map(decodeRow);
}

export async function markFired(id, firedAt) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    const r = await query(`UPDATE scheduled_events SET status='fired', fired_at=$1 WHERE id=$2 AND status='pending'`, [firedAt, id]);
    return r.rowCount;
  }
  return getStmts().markFired.run(firedAt, id).changes;
}

export async function markFailed(id, error) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    const r = await query(`UPDATE scheduled_events SET status='failed', error=$1 WHERE id=$2 AND status='pending'`, [error, id]);
    return r.rowCount;
  }
  return getStmts().markFailed.run(error, id).changes;
}

export async function markDispatchFailed(id, error) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    const r = await query(`UPDATE scheduled_events SET status='failed', error=$1 WHERE id=$2 AND status='fired'`, [error, id]);
    return r.rowCount;
  }
  return getStmts().markDispatchFailed.run(error, id).changes;
}

/**
 * Schedule a retry with exponential backoff: 30s, 60s, 120s (capped at 240s).
 * Returns true if retried, false if max_retries exhausted (caller should markFailed).
 */
export async function scheduleRetryOrFail(row, error) {
  const effectiveMax = parseInt(process.env.SCHEDULED_MAX_RETRIES ?? String(row.max_retries), 10);

  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    if (row.retry_count < effectiveMax) {
      const backoffMs  = Math.min(2 ** row.retry_count * 30_000, 240_000);
      const nextRetry  = Date.now() + backoffMs;
      await query(
        `UPDATE scheduled_events SET status='pending', retry_count=retry_count+1, next_retry_at=$1, error=$2 WHERE id=$3`,
        [nextRetry, error, row.id]
      );
      return true;
    }
    if (effectiveMax !== row.max_retries) {
      await query(`UPDATE scheduled_events SET max_retries=$1 WHERE id=$2`, [effectiveMax, row.id]);
    }
    await query(`UPDATE scheduled_events SET status='failed', error=$1 WHERE id=$2`, [error, row.id]);
    return false;
  }

  const s = getStmts();
  if (row.retry_count < effectiveMax) {
    const backoffMs  = Math.min(2 ** row.retry_count * 30_000, 240_000);
    const nextRetry  = Date.now() + backoffMs;
    s.scheduleRetry.run(nextRetry, error, row.id);
    return true;
  }
  if (effectiveMax !== row.max_retries) {
    getDb().prepare('UPDATE scheduled_events SET max_retries = ? WHERE id = ?').run(effectiveMax, row.id);
  }
  s.markRetryExhausted.run(error, row.id);
  return false;
}

export async function findDeadLetter(limit = 100) {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    return (await queryAll(
      `SELECT * FROM scheduled_events WHERE status='failed' AND retry_count>=max_retries ORDER BY fire_at DESC LIMIT $1`,
      [limit]
    )).map(decodeRow);
  }
  return getStmts().findDeadLetter.all(limit).map(decodeRow);
}

export async function cancelScheduledEvent(id, actorId) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    const r = await query(`UPDATE scheduled_events SET status='cancelled' WHERE id=$1 AND actor_id=$2 AND status='pending'`, [id, actorId]);
    return r.rowCount;
  }
  return getStmts().cancel.run(id, actorId).changes;
}

export async function cancelAllPendingForActor(actorId) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    const r = await query(`UPDATE scheduled_events SET status='cancelled' WHERE actor_id=$1 AND status='pending'`, [actorId]);
    return r.rowCount;
  }
  return getDb().prepare(
    `UPDATE scheduled_events SET status = 'cancelled' WHERE actor_id = ? AND status = 'pending'`
  ).run(actorId).changes;
}

export async function findByActor(actorId, status = 'all') {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    let rows;
    if (!status || status === 'all') {
      rows = await queryAll(`SELECT * FROM scheduled_events WHERE actor_id=$1 ORDER BY fire_at ASC`, [actorId]);
    } else if (status === 'pending') {
      rows = await queryAll(`SELECT * FROM scheduled_events WHERE actor_id=$1 AND status='pending' ORDER BY fire_at ASC`, [actorId]);
    } else {
      rows = await queryAll(`SELECT * FROM scheduled_events WHERE actor_id=$1 AND status=$2 ORDER BY fire_at ASC`, [actorId, status]);
    }
    return rows.map(decodeRow);
  }
  const s = getStmts();
  if (!status || status === 'all') return s.findByActorAll.all(actorId).map(decodeRow);
  if (status === 'pending') return s.findByActor.all(actorId).map(decodeRow);
  return s.findByActorStatus.all(actorId, status).map(decodeRow);
}

export async function findById(id) {
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    const row = await queryOne(`SELECT * FROM scheduled_events WHERE id=$1`, [id]);
    return row ? decodeRow(row) : null;
  }
  const row = getStmts().findById.get(id);
  return row ? decodeRow(row) : null;
}

function decodeRow(row) {
  let payload = null;
  if (row.payload_enc) {
    try {
      const buf = Buffer.isBuffer(row.payload_enc)
        ? row.payload_enc
        : Buffer.from(row.payload_enc);
      payload = JSON.parse(decrypt(buf).toString('utf8'));
    } catch { payload = null; }
  }
  return {
    id:          row.id,
    actorId:     row.actor_id,
    eventType:   row.event_type,
    payload,
    fireAt:      row.fire_at,
    status:      row.status,
    firedAt:     row.fired_at,
    error:       row.error,
    retry_count: row.retry_count,
    max_retries: row.max_retries,
    createdAt:   row.created_at,
  };
}
