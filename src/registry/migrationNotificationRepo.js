// src/registry/migrationNotificationRepo.js
import { randomUUID } from 'crypto';
import { getDb, isPostgres } from './db.js';

export async function insertMigrationNotification(actorId, fromDefinitionId, toDefinitionId) {
  const id = randomUUID();
  const now = Date.now();
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(
      `INSERT INTO migration_notifications (id, actor_id, from_definition_id, to_definition_id, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, actorId, fromDefinitionId, toDefinitionId, now]
    );
    return;
  }
  getDb().prepare(
    `INSERT INTO migration_notifications (id, actor_id, from_definition_id, to_definition_id, created_at)
     VALUES (?,?,?,?,?)`
  ).run(id, actorId, fromDefinitionId, toDefinitionId, now);
}

export async function consumePendingNotifications() {
  if (isPostgres) {
    const { queryAll, query } = await import('./db-postgres.js');
    const rows = await queryAll(
      `SELECT actor_id FROM migration_notifications WHERE consumed_at IS NULL`
    );
    if (rows.length > 0) {
      await query(`UPDATE migration_notifications SET consumed_at=$1 WHERE consumed_at IS NULL`, [Date.now()]);
    }
    return rows.map(r => r.actor_id);
  }
  const db = getDb();
  const rows = db.prepare(
    `SELECT actor_id FROM migration_notifications WHERE consumed_at IS NULL`
  ).all();
  if (rows.length > 0) {
    db.prepare(`UPDATE migration_notifications SET consumed_at=? WHERE consumed_at IS NULL`).run(Date.now());
  }
  return rows.map(r => r.actor_id);
}
