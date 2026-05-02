/**
 * test/e2e/webhooks.spec.js
 *
 * End-to-end tests for webhook registration, listing, deletion, ping delivery,
 * state.changed delivery, HMAC verification, URL validation, and cross-org isolation.
 *
 * A local HTTP server (http.createServer, port 0) acts as the delivery target.
 * The webhook-worker is spawned as a subprocess for delivery tests.
 */

import { test, expect }       from '@playwright/test';
import { createServer }        from 'http';
import { createHmac }          from 'crypto';
import { spawn }               from 'child_process';
import { resolve, dirname }    from 'path';
import { fileURLToPath }       from 'url';
import { GET, POST, PUT, DELETE, uniqueId } from './helpers/api.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolve(__dirname, '../../src/workers/webhook-worker.js');

const BASE       = process.env.STATEKEEP_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;
const ADMIN_KEY  = process.env.STATEKEEP_ADMIN_KEY ?? 'test-admin-key';
const SENTINEL   = '__test_key_do_not_use_in_production__';

const TEST_SECRET = 'test-webhook-secret-minimum-16-chars';

// ── Local delivery-target HTTP server ─────────────────────────────────────────

let testServer;
let testServerPort;
let received = [];

function waitForDelivery(timeoutMs = 5_000, webhookId = null) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      const pool = webhookId
        ? received.filter(r => r.body?.webhookId === webhookId)
        : received;
      if (pool.length > 0) return resolve(pool[pool.length - 1]);
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for webhook delivery'));
      setTimeout(check, 200);
    };
    check();
  });
}

test.beforeAll(async () => {
  received = [];
  testServer = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        received.push({
          method:  req.method,
          headers: req.headers,
          body:    JSON.parse(body),
          rawBody: body,
        });
      } catch {
        received.push({ method: req.method, headers: req.headers, body: {}, rawBody: body });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise(resolve => testServer.listen(0, '127.0.0.1', resolve));
  testServerPort = testServer.address().port;
});

test.afterAll(async () => {
  await new Promise(resolve => testServer.close(resolve));
});

test.beforeEach(() => {
  received = [];
});

// ── Helper: spawn webhook-worker subprocess ───────────────────────────────────

function spawnWorker() {
  const proc = spawn(process.execPath, [WORKER_PATH], {
    env: {
      ...process.env,
      STATEKEEP_DB_PATH:        process.env.STATEKEEP_DB_PATH ?? 'statekeep-test.db',
      STATEKEEP_ENCRYPTION_KEY: process.env.STATEKEEP_ENCRYPTION_KEY ?? '0'.repeat(64),
      STATEKEEP_ADMIN_KEY:      ADMIN_KEY,
      NODE_ENV:                 'test',
      WEBHOOK_POLL_INTERVAL:    '200',
    },
    cwd:   resolve(__dirname, '../..'),
    stdio: 'pipe',
  });
  proc.on('error', err => console.warn('[test] webhook-worker error:', err.message));
  return proc;
}

// ── Admin helpers (need both sentinel API key and admin key) ──────────────────

async function adminPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': SENTINEL, 'x-admin-key': ADMIN_KEY },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

// ── 1: Register ───────────────────────────────────────────────────────────────

test('POST /v1/webhooks registers a webhook and returns 201', async () => {
  const url    = `http://127.0.0.1:${testServerPort}`;
  const events = ['state.changed'];

  const res = await POST('/v1/webhooks', { url, secret: TEST_SECRET, events });
  expect(res.status).toBe(201);
  expect(res.body.id).toBeTruthy();
  expect(res.body.url).toBe(url);
  expect(res.body.events).toEqual(events);
  expect(res.body.active).toBe(true);
  expect(res.body.createdAt).toBeTruthy();
  // Secret must NOT appear in the response
  expect(JSON.stringify(res.body)).not.toContain(TEST_SECRET);
});

// ── 2: List ───────────────────────────────────────────────────────────────────

test('GET /v1/webhooks lists webhooks without exposing secret', async () => {
  const url = `http://127.0.0.1:${testServerPort}`;
  const reg = await POST('/v1/webhooks', { url, secret: TEST_SECRET, events: ['actor.terminated'] });
  expect(reg.status).toBe(201);

  const listRes = await GET('/v1/webhooks');
  expect(listRes.status).toBe(200);
  expect(Array.isArray(listRes.body.webhooks)).toBe(true);

  const found = listRes.body.webhooks.find(w => w.id === reg.body.id);
  expect(found).toBeDefined();
  expect(found.url).toBe(url);
  // Secret must not appear in any list item
  expect(JSON.stringify(listRes.body)).not.toContain(TEST_SECRET);
  listRes.body.webhooks.forEach(w => {
    expect(Object.keys(w)).not.toContain('secret');
  });
});

// ── 3: Delete ─────────────────────────────────────────────────────────────────

test('DELETE /v1/webhooks/:id deactivates webhook', async () => {
  const url = `http://127.0.0.1:${testServerPort}`;
  const reg = await POST('/v1/webhooks', { url, secret: TEST_SECRET, events: ['state.changed'] });
  expect(reg.status).toBe(201);
  const id = reg.body.id;

  const del = await DELETE(`/v1/webhooks/${id}`);
  expect(del.status).toBe(204);

  // Webhook should now be inactive — not returned in active listing
  const listRes = await GET('/v1/webhooks');
  const found   = listRes.body.webhooks.find(w => w.id === id);
  // Either not present, or present with active=false
  if (found) expect(found.active).toBe(false);
});

// ── 4: Ping delivery ─────────────────────────────────────────────────────────

test('POST /v1/webhooks/:id/ping delivers a test payload', async () => {
  const url = `http://127.0.0.1:${testServerPort}`;
  const reg = await POST('/v1/webhooks', { url, secret: TEST_SECRET, events: ['state.changed'] });
  expect(reg.status).toBe(201);
  const webhookId = reg.body.id;

  // Trigger ping
  const pingRes = await POST(`/v1/webhooks/${webhookId}/ping`, {});
  expect(pingRes.status).toBe(202);
  expect(pingRes.body.deliveryId).toBeTruthy();

  // Start worker and wait for delivery
  const worker = spawnWorker();
  try {
    const delivery = await waitForDelivery(5_000);
    expect(delivery.headers['x-statekeep-signature']).toMatch(/^sha256=[0-9a-f]+$/);
    expect(delivery.body.eventType).toBeTruthy();
    expect(delivery.body.webhookId).toBe(webhookId);
  } finally {
    worker.kill('SIGTERM');
  }
}, 12_000);

// ── 5: state.changed delivery with HMAC verification ─────────────────────────

test('state.changed event triggers webhook delivery with correct HMAC', async () => {
  const url    = `http://127.0.0.1:${testServerPort}`;
  const reg    = await POST('/v1/webhooks', { url, secret: TEST_SECRET, events: ['state.changed'] });
  expect(reg.status).toBe(201);
  const webhookId = reg.body.id;

  // Deploy definition and spawn actor
  const defId   = uniqueId('wh-def');
  const defRes  = await PUT('/v1/definitions', {
    id: defId,
    definition: {
      id: 'wh', initial: 'idle',
      states: {
        idle:    { on: { START: 'running' } },
        running: { on: { STOP: 'done' } },
        done:    { type: 'final' },
      },
    },
  });
  expect(defRes.status).toBe(201);

  const spawnRes = await POST('/v1/actors', { definitionId: defId });
  expect(spawnRes.status).toBe(201);
  const actorId = spawnRes.body.id;

  // Start worker BEFORE sending event so it catches the delivery
  const worker = spawnWorker();
  try {
    // Send event → triggers state.changed webhook emission
    const evRes = await POST(`/v1/actors/${actorId}/event`, { type: 'START' });
    expect(evRes.status).toBe(200);
    expect(evRes.body.stateValue).toBe('running');

    const delivery = await waitForDelivery(6_000, webhookId);

    // Verify HMAC independently
    const sig      = delivery.headers['x-statekeep-signature'];
    const expected = 'sha256=' + createHmac('sha256', TEST_SECRET)
      .update(delivery.rawBody)
      .digest('hex');
    expect(sig).toBe(expected);

    // Verify payload shape
    const p = delivery.body;
    expect(p.webhookId).toBe(webhookId);
    expect(p.eventType).toBe('state.changed');
    expect(p.orgId).toBeTruthy();
    expect(typeof p.timestamp).toBe('number');
    expect(p.data.actorId).toBe(actorId);
    expect(p.data.toState).toBe('running');
  } finally {
    worker.kill('SIGTERM');
  }
}, 14_000);

// ── 6: HTTP URL rejected ──────────────────────────────────────────────────────

test('webhook with non-localhost http URL is rejected with 400', async () => {
  const res = await POST('/v1/webhooks', {
    url:    'http://example.com/webhook',
    secret: TEST_SECRET,
    events: ['state.changed'],
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/https/i);
});

// ── 7: Cross-org isolation ────────────────────────────────────────────────────

test('cross-org: org A cannot delete org B webhook', async () => {
  // Create org A with a real key
  const orgARes = await adminPost('/v1/orgs', { name: uniqueId('wh-orgA') });
  expect(orgARes.status).toBe(201);
  const orgAId  = orgARes.body.id;

  const keyARes = await adminPost(`/v1/orgs/${orgAId}/keys`, { label: 'A', tier: 'enterprise' });
  expect(keyARes.status).toBe(201);
  const orgAKey = keyARes.body.rawKey;

  // Create org B with a real key
  const orgBRes = await adminPost('/v1/orgs', { name: uniqueId('wh-orgB') });
  expect(orgBRes.status).toBe(201);
  const orgBId  = orgBRes.body.id;

  const keyBRes = await adminPost(`/v1/orgs/${orgBId}/keys`, { label: 'B', tier: 'enterprise' });
  expect(keyBRes.status).toBe(201);
  const orgBKey = keyBRes.body.rawKey;

  // Register webhook under org A
  const regRes = await fetch(`${BASE}/v1/webhooks`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': orgAKey },
    body:    JSON.stringify({
      url:    `http://127.0.0.1:${testServerPort}`,
      secret: TEST_SECRET,
      events: ['state.changed'],
    }),
  });
  expect(regRes.status).toBe(201);
  const { id: webhookId } = await regRes.json();

  // Attempt DELETE with org B key → must be 404, not 403
  const delRes = await fetch(`${BASE}/v1/webhooks/${webhookId}`, {
    method:  'DELETE',
    headers: { 'x-api-key': orgBKey },
  });
  expect(delRes.status).toBe(404);
});

// ── 8: Deliveries endpoint ────────────────────────────────────────────────────

test('GET /v1/webhooks/:id/deliveries returns delivery history after ping', async () => {
  const url   = `http://127.0.0.1:${testServerPort}`;
  const reg   = await POST('/v1/webhooks', { url, secret: TEST_SECRET, events: ['state.changed'] });
  expect(reg.status).toBe(201);
  const webhookId = reg.body.id;

  await POST(`/v1/webhooks/${webhookId}/ping`, {});

  // Run worker until delivery completes
  const worker = spawnWorker();
  try {
    await waitForDelivery(5_000);
    // Give DB write time to settle
    await new Promise(r => setTimeout(r, 300));

    const histRes = await GET(`/v1/webhooks/${webhookId}/deliveries`);
    expect(histRes.status).toBe(200);
    expect(histRes.body.webhookId).toBe(webhookId);
    expect(Array.isArray(histRes.body.deliveries)).toBe(true);
    expect(histRes.body.deliveries.length).toBeGreaterThanOrEqual(1);

    const d = histRes.body.deliveries[0];
    expect(d.status).toBe('delivered');
    expect(typeof d.attempts).toBe('number');
    expect(d.responseCode).toBe(200);
    expect(d.payload).toBeTruthy();
    expect(typeof d.payload).toBe('object');
    // Secret must not appear in payload field
    expect(JSON.stringify(d)).not.toContain(TEST_SECRET);
  } finally {
    worker.kill('SIGTERM');
  }
}, 12_000);

test('GET /v1/webhooks/:id/deliveries?status=delivered filters correctly', async () => {
  const url   = `http://127.0.0.1:${testServerPort}`;
  const reg   = await POST('/v1/webhooks', { url, secret: TEST_SECRET, events: ['state.changed'] });
  expect(reg.status).toBe(201);
  const webhookId = reg.body.id;

  await POST(`/v1/webhooks/${webhookId}/ping`, {});
  const worker = spawnWorker();
  try {
    await waitForDelivery(5_000);
    await new Promise(r => setTimeout(r, 300));

    const res = await GET(`/v1/webhooks/${webhookId}/deliveries?status=delivered`);
    expect(res.status).toBe(200);
    res.body.deliveries.forEach(d => {
      expect(d.status).toBe('delivered');
    });
  } finally {
    worker.kill('SIGTERM');
  }
}, 12_000);

test('GET /v1/webhooks/:id/deliveries: cross-org returns 404', async () => {
  const orgARes = await adminPost('/v1/orgs', { name: uniqueId('dlv-orgA') });
  const orgAId  = orgARes.body.id;
  const keyARes = await adminPost(`/v1/orgs/${orgAId}/keys`, { label: 'A', tier: 'enterprise' });
  const orgAKey = keyARes.body.rawKey;

  const orgBRes = await adminPost('/v1/orgs', { name: uniqueId('dlv-orgB') });
  const orgBId  = orgBRes.body.id;
  const keyBRes = await adminPost(`/v1/orgs/${orgBId}/keys`, { label: 'B', tier: 'enterprise' });
  const orgBKey = keyBRes.body.rawKey;

  const regRes = await fetch(`${BASE}/v1/webhooks`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': orgAKey },
    body:    JSON.stringify({ url: `http://127.0.0.1:${testServerPort}`, secret: TEST_SECRET, events: ['state.changed'] }),
  });
  expect(regRes.status).toBe(201);
  const { id: webhookId } = await regRes.json();

  const delivRes = await fetch(`${BASE}/v1/webhooks/${webhookId}/deliveries`, {
    headers: { 'x-api-key': orgBKey },
  });
  expect(delivRes.status).toBe(404);
});
