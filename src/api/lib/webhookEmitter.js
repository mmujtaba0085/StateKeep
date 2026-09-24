/**
 * src/api/lib/webhookEmitter.js
 *
 * Inserts pending webhook_delivery rows for every active webhook in an org
 * that subscribes to the given event type. The webhook-worker picks them up.
 *
 * This function MUST never throw — errors are logged and swallowed.
 */

import { getDb, isPostgres } from '../../registry/db.js';
import { randomUUID } from 'crypto';

// Postgres path: this module only ever called getDb(), which throws in Postgres mode,
// so on Postgres no webhook delivery was ever queued (every emit logged an error).
async function emitPostgres(eventType, data) {
  const { queryAll, query } = await import('../../registry/db-postgres.js');
  const webhooks = await queryAll(
    `SELECT id FROM webhooks WHERE active = true AND events ? $1`, [eventType]);
  if (webhooks.length === 0) return;
  const now     = Date.now();
  const payload = JSON.stringify({ eventType, timestamp: now, data });
  for (const w of webhooks) {
    await query(
      `INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, attempts, created_at)
       VALUES ($1, $2, $3, $4, 'pending', 0, $5)`,
      [randomUUID(), w.id, eventType, payload, now]);
  }
}

export function emitWebhookEvent(eventType, data) {
  if (isPostgres) {
    emitPostgres(eventType, data)
      .catch((err) => console.error(`[webhookEmitter] Failed to emit ${eventType}:`, err.message));
    return;
  }
  try {
    const db = getDb();

    // Find all active webhooks that subscribe to this event type.
    // json_each() unpacks the stored JSON array so we can match individual values.
    const webhooks = db.prepare(`
      SELECT DISTINCT w.id
      FROM webhooks w, json_each(w.events) je
      WHERE w.active = 1 AND je.value = ?
    `).all(eventType);

    if (webhooks.length === 0) return;

    const insert = db.prepare(`
      INSERT INTO webhook_deliveries
        (id, webhook_id, event_type, payload, status, attempts, created_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?)
    `);

    const now     = Date.now();
    const payload = JSON.stringify({ eventType, timestamp: now, data });

    for (const webhook of webhooks) {
      insert.run(randomUUID(), webhook.id, eventType, payload, now);
    }
  } catch (err) {
    console.error(`[webhookEmitter] Failed to emit ${eventType}:`, err.message);
  }
}
