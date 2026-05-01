/**
 * src/api/lib/webhookEmitter.js
 *
 * Inserts pending webhook_delivery rows for every active webhook in an org
 * that subscribes to the given event type. The webhook-worker picks them up.
 *
 * This function MUST never throw — errors are logged and swallowed.
 */

import { getDb } from '../../registry/db.js';
import { randomUUID } from 'crypto';

export function emitWebhookEvent(orgId, eventType, data) {
  try {
    const db = getDb();

    // Find all active webhooks for this org that subscribe to this event type.
    // json_each() unpacks the stored JSON array so we can match individual values.
    const webhooks = db.prepare(`
      SELECT DISTINCT w.id
      FROM webhooks w, json_each(w.events) je
      WHERE w.org_id = ? AND w.active = 1 AND je.value = ?
    `).all(orgId, eventType);

    if (webhooks.length === 0) return;

    const insert = db.prepare(`
      INSERT INTO webhook_deliveries
        (id, webhook_id, org_id, event_type, payload, status, attempts, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)
    `);

    const now     = Date.now();
    const payload = JSON.stringify({ eventType, orgId, timestamp: now, data });

    for (const webhook of webhooks) {
      insert.run(randomUUID(), webhook.id, orgId, eventType, payload, now);
    }
  } catch (err) {
    console.error(`[webhookEmitter] Failed to emit ${eventType} for org ${orgId}:`, err.message);
  }
}
