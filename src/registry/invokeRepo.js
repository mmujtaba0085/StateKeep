// src/registry/invokeRepo.js
import { getDb, isPostgres } from './db.js';

export async function insertRunningInvoke({ id, actorId, invokeId, serviceId, startedAt, timeoutAt, correlationId, idempotent }) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(
      `INSERT INTO running_invokes (id, actor_id, invoke_id, service_id, started_at, timeout_at, correlation_id, idempotent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, actorId, invokeId, serviceId, startedAt, timeoutAt, correlationId, idempotent ? 1 : 0]
    );
    return;
  }
  getDb().prepare(
    `INSERT INTO running_invokes (id, actor_id, invoke_id, service_id, started_at, timeout_at, correlation_id, idempotent)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, actorId, invokeId, serviceId, startedAt, timeoutAt, correlationId, idempotent ? 1 : 0);
}

export async function markInvokeDone(id) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`UPDATE running_invokes SET status='done' WHERE id=$1`, [id]);
    return;
  }
  getDb().prepare(`UPDATE running_invokes SET status='done' WHERE id=?`).run(id);
}

export async function markInvokeFailed(id) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`UPDATE running_invokes SET status='failed' WHERE id=$1`, [id]);
    return;
  }
  getDb().prepare(`UPDATE running_invokes SET status='failed' WHERE id=?`).run(id);
}

export async function loadRunningInvokes() {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    return queryAll(`SELECT * FROM running_invokes WHERE status='running'`);
  }
  return getDb().prepare(`SELECT * FROM running_invokes WHERE status='running'`).all();
}
