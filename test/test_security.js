/**
 * test/test_security.js
 *
 * Access-control and hardening regression tests. Starts its OWN server (with an
 * API key and admin key) on a separate port, so it runs independently of the
 * shared open-mode test server used by the rest of the suite.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { guardedLookup, isBlockedAddress, assertSafeWebhookUrl } from '../src/api/lib/urlGuard.js';
import { applyContextTransform } from '../src/runtime/actorWorker.js';

const PORT   = 3097;
const BASE   = `http://127.0.0.1:${PORT}`;
const KEY    = 'sk_test_' + 'k'.repeat(24);
const ADMIN  = 'adm_test_' + 'a'.repeat(24);
const dir    = mkdtempSync(join(tmpdir(), 'sk-sec-'));
let server, scheduler;

const env = {
  ...process.env,
  PORT: String(PORT),
  NODE_ENV: 'development',                 // rate limiter active (it is disabled under NODE_ENV=test)
  STATEKEEP_DB_PATH: join(dir, 'sec.db'),
  STATEKEEP_ENCRYPTION_KEY: 'ab'.repeat(32),
  STATEKEEP_API_KEY: KEY,
  STATEKEEP_ADMIN_KEY: ADMIN,
  STATEKEEP_RATE_LIMIT_MAX: '400',
  LOG_DIR: join(dir, 'logs'),
  STATEKEEP_DATA_DIR: join(dir, 'data'),
  HOST: '127.0.0.1',
};
delete env.STATEKEEP_ALLOW_UNAUTHENTICATED;
delete env.STATEKEEP_TRUST_PROXY;

async function req(method, path, { body, key = KEY, headers = {} } = {}) {
  const h = { ...headers };
  if (key) h['x-api-key'] = key;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

before(async () => {
  server = spawn(process.execPath, ['src/api/server.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/v1/health`)).ok) break; } catch {}
    await new Promise((r) => { setTimeout(r, 250); });
  }
  scheduler = spawn(process.execPath, ['src/workers/scheduler-worker.js'], { env, stdio: 'ignore' });
  const d = await req('PUT', '/v1/definitions', { body: { id: 'sec-v1', definition: { id: 'sec', initial: 'a', states: { a: { on: { T: 'b' } }, b: { on: { T: 'a' } } } } } });
  assert.equal(d.status, 201);
});

after(() => { scheduler?.kill('SIGKILL'); server?.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });

// ── Authentication ──────────────────────────────────────────────────────────
test('health is public; everything else needs the key', async () => {
  assert.equal((await req('GET', '/v1/health', { key: null })).status, 200);
  assert.equal((await req('GET', '/v1/actors', { key: null })).status, 401);
  assert.equal((await req('GET', '/v1/actors', { key: 'wrong' })).status, 403);
  assert.equal((await req('GET', '/v1/actors')).status, 200);
});

test('percent-encoded paths cannot bypass authentication', async () => {
  for (const p of ['/%76%31/actors', '/v%31/actors', '/%761/definitions']) {
    const r = await req('GET', p, { key: null });
    assert.ok([401, 404].includes(r.status), `${p} → ${r.status}`);
  }
});

test('admin routes need the admin key; a forged proxy header does not help', async () => {
  assert.equal((await req('POST', '/v1/admin/workers/actor/restart')).status, 403);
  assert.equal((await req('POST', '/v1/admin/workers/actor/restart', { headers: { 'x-forwarded-for': '127.0.0.1' } })).status, 403);
  assert.equal((await req('POST', '/v1/admin/workers/migrate/restart', { headers: { 'x-admin-key': ADMIN } })).status, 200);
});

test('refuses to start unauthenticated on a public interface', () => {
  const r = spawnSync(process.execPath, ['src/api/server.js'], {
    env: { ...env, PORT: '3096', HOST: '0.0.0.0', STATEKEEP_API_KEY: '' }, encoding: 'utf8', timeout: 15000,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /Refusing to start/);
});

// ── Input hardening ─────────────────────────────────────────────────────────
test('event payload cannot override the event type', async () => {
  const { id } = (await req('POST', '/v1/actors', { body: { definitionId: 'sec-v1' } })).body;
  await req('POST', `/v1/actors/${id}/event`, { body: { type: 'NOPE', payload: { type: 'T' } } });
  assert.equal((await req('GET', `/v1/actors/${id}`)).body.stateValue, 'a');
});

test('contextTransform paths reaching Object.prototype are rejected', async () => {
  const r = await req('PUT', '/v1/definitions', { body: {
    id: 'sec-v2', parentId: 'sec-v1',
    definition: { id: 'sec', initial: 'a', states: { a: { on: { T: 'b' } }, b: { on: { T: 'a' } } } },
    contextTransform: { '__proto__.polluted': 'x' },
  } });
  assert.equal(r.status, 400);
  assert.throws(() => applyContextTransform({ x: 1 }, { '__proto__.polluted': 'x' }));
  assert.equal(({}).polluted, undefined);
});

test('webhooks cannot target internal addresses', async () => {
  for (const url of ['https://169.254.169.254/', 'https://127.0.0.1/', 'https://10.0.0.1/', 'https://[::ffff:10.0.0.1]/', 'http://example.com/']) {
    const r = await req('POST', '/v1/webhooks', { body: { url, secret: 's'.repeat(16), events: ['state.changed'] } });
    assert.equal(r.status, 400, url);
  }
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:a00:1', '64:ff9b::a9fe:a9fe']) {
    assert.ok(isBlockedAddress(a), a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!isBlockedAddress(a), a);
  await assert.rejects(assertSafeWebhookUrl('https://2130706433/'));   // decimal-encoded 127.0.0.1
});

test('webhook delivery re-checks the address at connect time (DNS rebinding)', async () => {
  // 'localhost' resolves to loopback: the guarded lookup must refuse to connect.
  const err = await new Promise((resolve) => {
    const r = https.request({ host: 'localhost', port: 9, method: 'POST', lookup: guardedLookup }, () => resolve(null));
    r.on('error', resolve);
    r.end();
  });
  assert.equal(err?.code, 'EBLOCKEDADDR');
});

test('dead-letter endpoint is admin-only and returns a real list', async () => {
  assert.equal((await req('GET', '/v1/scheduled/dead-letter')).status, 403);
  const r = await req('GET', '/v1/scheduled/dead-letter', { headers: { 'x-admin-key': ADMIN } });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.deadLetter));
});

test('a fired scheduled event is visible through the API and cannot be undone', async () => {
  await req('PUT', '/v1/definitions', { body: { id: 'offer-v1', definition: { id: 'offer', initial: 'open',
    states: { open: { on: { NUDGE: 'open', EXPIRE: 'expired' } }, expired: { type: 'final' } } } } });
  const { id } = (await req('POST', '/v1/actors', { body: { definitionId: 'offer-v1' } })).body;
  await req('GET', `/v1/actors/${id}`);                                   // server now has it cached
  assert.equal((await req('POST', `/v1/actors/${id}/schedule`, { body: { type: 'EXPIRE', fireAt: Date.now() + 300 } })).status, 201);
  let state;
  for (let i = 0; i < 40 && state !== 'expired'; i++) {
    await new Promise((r) => { setTimeout(r, 250); });
    state = (await req('GET', `/v1/actors/${id}`)).body.stateValue;
  }
  assert.equal(state, 'expired', 'API must show the scheduler-fired transition');
  const r = await req('POST', `/v1/actors/${id}/event`, { body: { type: 'NUDGE' } });
  assert.equal(r.status, 409, 'an expired offer must not be revived by a later event');
});

test('concurrent duplicates with one idempotency key are applied exactly once', async () => {
  for (let run = 0; run < 3; run++) {
    const { id } = (await req('POST', '/v1/actors', { body: { definitionId: 'sec-v1' } })).body;
    const rs = await Promise.all(Array.from({ length: 10 }, () =>
      req('POST', `/v1/actors/${id}/event`, { body: { type: 'T', idempotencyKey: `k-${run}` } })));
    assert.equal(rs.filter((r) => r.status === 200 && !r.body.idempotent).length, 1);
    assert.equal((await req('GET', `/v1/actors/${id}`)).body.stateValue, 'b', 'T applied once (a → b)');
  }
});

// ── Rate limiting (keep last: it exhausts the budget) ───────────────────────
test('rate limit answers 429 and cannot be dodged with X-Forwarded-For', async () => {
  let saw429 = false;
  for (let i = 0; i < 450 && !saw429; i++) {
    const r = await req('GET', '/v1/definitions', { headers: { 'x-forwarded-for': `10.9.${i % 250}.${i % 7}` } });
    assert.notEqual(r.status, 500, 'rate limit must not surface as a server error');
    if (r.status === 429) saw429 = true;
  }
  assert.ok(saw429, 'spoofed X-Forwarded-For must not reset the per-client limit');
});
