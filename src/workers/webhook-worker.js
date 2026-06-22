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
import { getDb, decrypt, isPostgres } from '../registry/db.js';
import { startHeartbeat } from './heartbeat.js';
import { engineReady } from '../ffi/engine.js';

const POLL_INTERVAL_MS       = parseInt(process.env.WEBHOOK_POLL_INTERVAL ?? '2000', 10);
const MAX_CONCURRENT         = 20;
const REQUEST_TIMEOUT_MS     = 10_000;
const MAX_RETRIES            = 3;
const AUTO_DISABLE_THRESHOLD = 10;
const BACKOFF_MS             = [30_000, 60_000, 120_000];

console.log('[webhook-worker] Starting...');
await engineReady;

if (isPostgres) {
  const { bootstrapSchema } = await import('../registry/db-postgres.js');
  await bootstrapSchema();
} else {
  getDb();
}

startHeartbeat('webhook');

async function deliverOne(delivery) {
  let webhook;
  if (isPostgres) {
    const { queryOne } = await import('../registry/db-postgres.js');
    webhook = await queryOne(`SELECT id, url, secret, active FROM webhooks WHERE id=$1`, [delivery.webhook_id]);
  } else {
    webhook = getDb().prepare(`SELECT id, url, secret, active FROM webhooks WHERE id = ?`).get(delivery.webhook_id);
  }

  const isActive = webhook?.active === 1 || webhook?.active === true;
  if (!webhook || !isActive) {
    if (isPostgres) {
      const { query } = await import('../registry/db-postgres.js');
      await query(`UPDATE webhook_deliveries SET status='failed', error='Webhook deactivated', last_attempt=$1 WHERE id=$2`, [Date.now(), delivery.id]);
    } else {
      getDb().prepare(`UPDATE webhook_deliveries SET status='failed', error='Webhook deactivated', last_attempt=? WHERE id=?`).run(Date.now(), delivery.id);
    }
    return;
  }

  let secret;
  try {
    const raw = Buffer.isBuffer(webhook.secret) ? webhook.secret : Buffer.from(webhook.secret);
    secret    = decrypt(raw).toString('utf8');
  } catch (err) {
    if (isPostgres) {
      const { query } = await import('../registry/db-postgres.js');
      await query(`UPDATE webhook_deliveries SET status='failed', error='Secret decryption failed', last_attempt=$1 WHERE id=$2`, [Date.now(), delivery.id]);
    } else {
      getDb().prepare(`UPDATE webhook_deliveries SET status='failed', error='Secret decryption failed', last_attempt=? WHERE id=?`).run(Date.now(), delivery.id);
    }
    return;
  }

  let parsedPayload;
  try {
    parsedPayload = typeof delivery.payload === 'string' ? JSON.parse(delivery.payload) : delivery.payload;
  } catch { parsedPayload = {}; }

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

  if (isPostgres) {
    const { query, queryOne } = await import('../registry/db-postgres.js');
    if (success) {
      await query(`UPDATE webhook_deliveries SET status='delivered', attempts=$1, response_code=$2, last_attempt=$3 WHERE id=$4`, [attempts, responseCode, now, delivery.id]);
      await query(`UPDATE webhooks SET last_fired_at=$1 WHERE id=$2`, [now, webhook.id]);
    } else if (attempts >= MAX_RETRIES) {
      await query(`UPDATE webhook_deliveries SET status='failed', attempts=$1, response_code=$2, error=$3, last_attempt=$4 WHERE id=$5`,
        [attempts, responseCode, errorMsg ?? `HTTP ${responseCode}`, now, delivery.id]);
      const updated = await queryOne(`UPDATE webhooks SET failure_count=failure_count+1 WHERE id=$1 RETURNING failure_count`, [webhook.id]);
      const newCount = updated?.failure_count ?? 0;
      if (newCount >= AUTO_DISABLE_THRESHOLD) {
        await query(`UPDATE webhooks SET active=false WHERE id=$1`, [webhook.id]);
        console.warn(`[webhook-worker] Auto-disabled webhook ${webhook.id} (failure_count=${newCount})`);
      }
    } else {
      const nextRetryAt = now + (BACKOFF_MS[attempts - 1] ?? 120_000);
      await query(`UPDATE webhook_deliveries SET attempts=$1, response_code=$2, error=$3, last_attempt=$4, next_retry_at=$5 WHERE id=$6`,
        [attempts, responseCode, errorMsg ?? `HTTP ${responseCode}`, now, nextRetryAt, delivery.id]);
    }
  } else {
    const db = getDb();
    if (success) {
      db.prepare(`UPDATE webhook_deliveries SET status='delivered', attempts=?, response_code=?, last_attempt=? WHERE id=?`)
        .run(attempts, responseCode, now, delivery.id);
      db.prepare(`UPDATE webhooks SET last_fired_at=? WHERE id=?`).run(now, webhook.id);
    } else if (attempts >= MAX_RETRIES) {
      db.prepare(`UPDATE webhook_deliveries SET status='failed', attempts=?, response_code=?, error=?, last_attempt=? WHERE id=?`)
        .run(attempts, responseCode, errorMsg ?? `HTTP ${responseCode}`, now, delivery.id);
      const updated = db.prepare(`UPDATE webhooks SET failure_count=failure_count+1 WHERE id=? RETURNING failure_count`).get(webhook.id);
      const newCount = updated?.failure_count ?? 0;
      if (newCount >= AUTO_DISABLE_THRESHOLD) {
        db.prepare(`UPDATE webhooks SET active=0 WHERE id=?`).run(webhook.id);
        console.warn(`[webhook-worker] Auto-disabled webhook ${webhook.id} (failure_count=${newCount})`);
      }
    } else {
      const nextRetryAt = now + (BACKOFF_MS[attempts - 1] ?? 120_000);
      db.prepare(`UPDATE webhook_deliveries SET attempts=?, response_code=?, error=?, last_attempt=?, next_retry_at=? WHERE id=?`)
        .run(attempts, responseCode, errorMsg ?? `HTTP ${responseCode}`, now, nextRetryAt, delivery.id);
    }
  }
}

async function pollAndDeliver() {
  const now = Date.now();
  let pending;

  if (isPostgres) {
    const { queryAll } = await import('../registry/db-postgres.js');
    pending = await queryAll(
      `SELECT id, webhook_id, org_id, event_type, payload, attempts FROM webhook_deliveries WHERE status='pending' AND (next_retry_at IS NULL OR next_retry_at<=$1) ORDER BY created_at ASC LIMIT $2`,
      [now, MAX_CONCURRENT]
    );
  } else {
    pending = getDb().prepare(`
      SELECT id, webhook_id, org_id, event_type, payload, attempts
      FROM webhook_deliveries
      WHERE status = 'pending'
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?
    `).all(now, MAX_CONCURRENT);
  }

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
