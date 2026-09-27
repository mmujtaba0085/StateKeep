/**
 * test/test_delivery.js — "never silently repeats a side effect" (docs/side-effects.md).
 *
 * Real processes: a StateKeep server and the Python service in examples/delivery. Each
 * test kills something at the worst moment (the server mid-call, the service right after
 * the effect, a request that never answers) and counts the real effects afterwards.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedPostgres } from './helpers/isolatedDb.js';

const PY_PORT = 8120, PORT = 3120, BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'delivery-secret';
const dir = mkdtempSync(join(tmpdir(), 'sk-delivery-'));
const EFFECTS = join(dir, 'effects.jsonl');
let py, server;

const env = {
  ...process.env, PORT: String(PORT), NODE_ENV: 'test', HOST: '127.0.0.1',
  STATEKEEP_DB_PATH: join(dir, 'd.db'), STATEKEEP_ENCRYPTION_KEY: '7c'.repeat(32),
  STATEKEEP_ADMIN_KEY: 'delivery-admin-key-123456',
  STATEKEEP_REMOTE_URL: `http://127.0.0.1:${PY_PORT}/statekeep`, STATEKEEP_REMOTE_SECRET: SECRET,
  STATEKEEP_REMOTE_TIMEOUT_MS: '6000', STATEKEEP_ACTION_LEASE_MS: '1500',
  LOG_DIR: join(dir, 'logs'), STATEKEEP_DATA_DIR: join(dir, 'data'),
};
delete env.STATEKEEP_API_KEY;
const pyEnv = { ...process.env, PORT: String(PY_PORT), STATEKEEP_REMOTE_SECRET: SECRET,
  PAY_JOB_STORE: join(dir, 'jobs.sqlite'), BANK_FILE: join(dir, 'bank.jsonl'), EFFECTS_FILE: EFFECTS };

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const j = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const waitFor = async (fn, ms = 30_000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; };
const effects = (id, kind) => (existsSync(EFFECTS) ? readFileSync(EFFECTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
  .filter((e) => e.actorId === id && (!kind || e.kind === kind));
const state = async (id) => (await j('GET', `/v1/actors/${id}`)).body.stateValue;
const until = async (id, want) => {
  const ok = await waitFor(async () => (await state(id)) === want);
  assert.ok(ok, `timed out waiting for ${want}; now ${await state(id)}`);
};
const historyCount = async (id, type) => (await j('GET', `/v1/actors/${id}/events?limit=200`)).body.events
  .filter((e) => (e.eventType ?? e.type) === type).length;

async function startServer() {
  server = spawn(process.execPath, ['src/api/server.js'], { env, stdio: 'ignore' });
  assert.ok(await waitFor(async () => { try { return (await fetch(`${BASE}/v1/health`)).ok; } catch { return false; } }), 'server up');
}
async function startService() {
  py = spawn('python3', ['examples/delivery/payments_service.py'], { env: pyEnv, stdio: 'ignore' });
  await waitFor(async () => { try { await fetch(`http://127.0.0.1:${PY_PORT}/`); return true; } catch { return false; } });
}
async function crashServer() { server.kill('SIGKILL'); await sleep(300); await startServer(); }
async function newPayment(context) {
  return (await j('POST', '/v1/actors', { definitionId: 'payment-v1', initialContext: context })).body.id;
}

before(async () => {
  const pgUrl = await isolatedPostgres('delivery');
  if (pgUrl) env.STATEKEEP_DB_URL = pgUrl;
  await startService();
  await startServer();
  const def = JSON.parse(readFileSync('examples/delivery/payments.definition.json', 'utf8'));
  const r = await j('PUT', '/v1/definitions', { id: 'payment-v1', definition: def });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});
after(() => { server?.kill('SIGKILL'); py?.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });

test('idempotent: server killed mid-charge → retried with the same key, the bank charges once', async () => {
  const id = await newPayment({ amount: 50, slowMs: 2000 });
  await j('POST', `/v1/actors/${id}/event`, { type: 'CHARGE' });
  await waitFor(async () => (await state(id)) === 'charging');
  await sleep(700);                      // the call is now in flight
  await crashServer();
  await until(id, 'done');
  assert.equal(effects(id, 'charge').length, 1, 'charged exactly once');
  assert.equal(await historyCount(id, 'CHARGED'), 1, 'follow-up event delivered once');
});

test('verify: the service dies right after refunding → StateKeep asks, the bank says done, no second refund', async () => {
  const id = await newPayment({ amount: 20, crashAfterEffect: true });
  await j('POST', `/v1/actors/${id}/event`, { type: 'REFUND' });
  assert.ok(await waitFor(async () => effects(id, 'refund').length === 1), 'refund performed');
  await sleep(300);
  await startService();                  // the service comes back; StateKeep re-asks
  await until(id, 'done');
  assert.equal(effects(id, 'refund').length, 1, 'refunded exactly once');
  assert.equal(await historyCount(id, 'REFUNDED'), 1);
});

test('verify (SDK job store): server killed mid-call → still running, then done → no repeat', async () => {
  const id = await newPayment({ slowMs: 2500 });
  await j('POST', `/v1/actors/${id}/event`, { type: 'NOTIFY' });
  await waitFor(async () => (await state(id)) === 'notifying');
  await sleep(700);
  await crashServer();
  await until(id, 'done');
  assert.equal(effects(id, 'notify').length, 1);
  assert.equal(await historyCount(id, 'NOTIFIED'), 1);
});

test('at-most-once: server killed mid-SMS → not repeated; a human confirms it was sent', async () => {
  const id = await newPayment({ slowMs: 2000 });
  await j('POST', `/v1/actors/${id}/event`, { type: 'SMS' });
  await waitFor(async () => (await state(id)) === 'texting');
  await sleep(700);
  await crashServer();
  await until(id, 'needs_review');
  await sleep(2500);
  assert.equal(effects(id, 'sms').length, 1, 'the in-flight SMS went out once and was never re-sent');

  const list = (await j('GET', '/v1/action-jobs?outcome=unknown')).body.jobs.filter((x) => x.actorId === id);
  assert.equal(list.length, 1);
  assert.equal(list[0].actionName, 'sendSms');
  const r = await j('POST', `/v1/action-jobs/${list[0].id}/resolve`, { happened: true, event: { type: 'SMS_SENT' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(id, 'done');
  assert.equal((await j('POST', `/v1/action-jobs/${list[0].id}/resolve`, { happened: true })).status, 409, 'resolved only once');
  assert.equal(effects(id, 'sms').length, 1);
});

test('at-most-once: a request that never answers → review; "it did not happen" → sent once', async () => {
  const id = await newPayment({ hangFirstAttempt: 7000 });   // longer than the 6s timeout; no effect
  await j('POST', `/v1/actors/${id}/event`, { type: 'SMS' });
  await until(id, 'needs_review');
  assert.equal(effects(id, 'sms').length, 0);
  const job = (await j('GET', '/v1/action-jobs')).body.jobs.find((x) => x.actorId === id);
  await sleep(1500);                                         // the reviewer checks the gateway: nothing sent
  assert.equal((await j('POST', `/v1/action-jobs/${job.id}/resolve`, { happened: false })).status, 200);
  await until(id, 'done');
  assert.equal(effects(id, 'sms').length, 1);
});

test('at-most-once: the service dies mid-call → review; "did not happen" re-runs even though the service had it as started', async () => {
  const id = await newPayment({ crashFirstAttempt: true });
  await j('POST', `/v1/actors/${id}/event`, { type: 'SMS' });
  await until(id, 'needs_review');
  await startService();
  const job = (await j('GET', '/v1/action-jobs')).body.jobs.find((x) => x.actorId === id);
  assert.equal((await j('POST', `/v1/action-jobs/${job.id}/resolve`, { happened: false })).status, 200);
  await until(id, 'done');
  assert.equal(effects(id, 'sms').length, 1);
});

test('service down (connection refused): nothing was sent, so even at-most-once is retried', async () => {
  py.kill('SIGKILL');
  await sleep(300);
  const id = await newPayment({});
  await j('POST', `/v1/actors/${id}/event`, { type: 'SMS' });
  await sleep(2000);
  assert.equal(await state(id), 'texting');
  await startService();
  await until(id, 'done');
  assert.equal(effects(id, 'sms').length, 1);
});

test('an action longer than the lease is not started twice (lease renewal)', async () => {
  const id = await newPayment({ slowMs: 4500 });             // lease is 1.5s
  await j('POST', `/v1/actors/${id}/event`, { type: 'SMS' });
  await until(id, 'done');
  assert.equal(effects(id, 'sms').length, 1);
});
