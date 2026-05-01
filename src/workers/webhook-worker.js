/**
 * src/workers/webhook-worker.js
 *
 * Polls webhook_deliveries every 2 seconds for pending rows and delivers them.
 *
 * Per delivery:
 *   1. Load webhook config, verify active=1
 *   2. Decrypt stored HMAC secret
 *   3. Sign payload with HMAC-SHA256 → X-StateKeep-Signature: sha256=<hex>
 *   4. POST to webhook.url with 10s timeout
 *   5. 2xx → mark delivered, update last_fired_at
 *   6. Non-2xx / timeout → increment attempts
 *      < 3 attempts: leave pending, set next_retry_at (30s, 60s, 120s backoff)
 *      >= 3 attempts: mark failed, increment webhook.failure_count
 *      failure_count >= 10: auto-disable webhook (active=0)
 */

import { createHmac } from 'crypto';
import { getDb, decrypt } from '../registry/db.js';
import { startHeartbeat } from './heartbeat.js';
import { engineReady } from '../ffi/engine.js';

const POLL_INTERVAL_MS       = parseInt(process.env.WEBHOOK_POLL_INTERVAL ?? '2000', 10);
const MAX_CONCURRENT         = 20;
const REQUEST_TIMEOUT_MS     = 10_000;
const MAX_RETRIES            = 3;
const AUTO_DISABLE_THRESHOLD = 10;
const BACKOFF_MS             = [30_000, 60_000, 120_000];   // 30s, 60s, 120s

console.log('[webhook-worker] Starting...');
await engineReady;
getDb();
startHeartbeat('webhook');

async function deliverOne(delivery) {
  const db = getDb();

  const webhook = db.prepare(`
    SELECT id, url, secret, active FROM webhooks WHERE id = ?
  `).get(delivery.webhook_id);

  if (!webhook || webhook.active === 0) {
    db.prepare(`
      UPDATE webhook_deliveries
      SET status = 'failed', error = 'Webhook deactivated', last_attempt = ?
      WHERE id = ?
    `).run(Date.now(), delivery.id);
    return;
  }

  let secret;
  try {
    const raw = Buffer.isBuffer(webhook.secret) ? webhook.secret : Buffer.from(webhook.secret);
    secret    = decrypt(raw).toString('utf8');
  } catch (err) {
    db.prepare(`
      UPDATE webhook_deliveries
      SET status = 'failed', error = 'Secret decryption failed', last_attempt = ?
      WHERE id = ?
    `).run(Date.now(), delivery.id);
    return;
  }

  // Build the outgoing JSON body (full envelope)
  let parsedPayload;
  try { parsedPayload = JSON.parse(delivery.payload); } catch { parsedPayload = {}; }

  const outbound = JSON.stringify({
    id:        delivery.id,
    webhookId: delivery.webhook_id,
    eventType: delivery.event_type,
    orgId:     delivery.org_id,
    timestamp: Date.now(),
    data:      parsedPayload.data ?? {},
  });

  const sig = createHmac('sha256', secret).update(outbound).digest('hex');

  let responseCode = null;
  let errorMsg     = null;
  let success      = false;

  try {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const res = await fetch(webhook.url, {
      method:  'POST',
      headers: {
        'Content-Type':          'application/json',
        'X-StateKeep-Signature': `sha256=${sig}`,
      },
      body:   outbound,
      signal: controller.signal,
    });

    clearTimeout(timer);
    responseCode = res.status;
    success      = res.ok;
  } catch (err) {
    errorMsg = err.name === 'AbortError' ? 'Request timed out after 10s' : err.message;
  }

  const attempts = delivery.attempts + 1;
  const now      = Date.now();

  if (success) {
    db.prepare(`
      UPDATE webhook_deliveries
      SET status = 'delivered', attempts = ?, response_code = ?, last_attempt = ?
      WHERE id = ?
    `).run(attempts, responseCode, now, delivery.id);

    db.prepare(`
      UPDATE webhooks SET last_fired_at = ? WHERE id = ?
    `).run(now, webhook.id);

  } else if (attempts >= MAX_RETRIES) {
    db.prepare(`
      UPDATE webhook_deliveries
      SET status = 'failed', attempts = ?, response_code = ?, error = ?, last_attempt = ?
      WHERE id = ?
    `).run(attempts, responseCode, errorMsg ?? `HTTP ${responseCode}`, now, delivery.id);

    const updated = db.prepare(`
      UPDATE webhooks SET failure_count = failure_count + 1
      WHERE id = ?
      RETURNING failure_count
    `).get(webhook.id);

    const newCount = updated?.failure_count ?? 0;
    if (newCount >= AUTO_DISABLE_THRESHOLD) {
      db.prepare(`UPDATE webhooks SET active = 0 WHERE id = ?`).run(webhook.id);
      console.warn(`[webhook-worker] Auto-disabled webhook ${webhook.id} (failure_count=${newCount})`);
    }

  } else {
    const nextRetryAt = now + (BACKOFF_MS[attempts - 1] ?? 120_000);
    db.prepare(`
      UPDATE webhook_deliveries
      SET attempts = ?, response_code = ?, error = ?, last_attempt = ?, next_retry_at = ?
      WHERE id = ?
    `).run(attempts, responseCode, errorMsg ?? `HTTP ${responseCode}`, now, nextRetryAt, delivery.id);
  }
}

async function pollAndDeliver() {
  const db  = getDb();
  const now = Date.now();

  const pending = db.prepare(`
    SELECT id, webhook_id, org_id, event_type, payload, attempts
    FROM webhook_deliveries
    WHERE status = 'pending'
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY created_at ASC
    LIMIT ?
  `).all(now, MAX_CONCURRENT);

  if (pending.length === 0) return;

  console.log(`[webhook-worker] Delivering ${pending.length} pending webhook(s)`);
  await Promise.allSettled(pending.map(deliverOne));
}

async function webhookLoop() {
  while (true) {
    try {
      await pollAndDeliver();
    } catch (err) {
      console.error('[webhook-worker] Poll error:', err.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

webhookLoop().catch(err => {
  console.error('[webhook-worker] Fatal:', err);
  process.exit(1);
});
