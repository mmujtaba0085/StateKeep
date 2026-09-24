/**
 * test/test_remote.js — guards/actions implemented by an HTTP service in another
 * language (examples/remote-python/service.py). Starts its own Python service and
 * StateKeep server on separate ports.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PY_PORT = 8097, PORT = 3095, BASE = `http://127.0.0.1:${PORT}`;
const SECRET  = 'remote-test-secret';
const dir     = mkdtempSync(join(tmpdir(), 'sk-remote-'));
let py, server;

const env = {
  ...process.env, PORT: String(PORT), NODE_ENV: 'test', HOST: '127.0.0.1',
  STATEKEEP_DB_PATH: join(dir, 'r.db'), STATEKEEP_ENCRYPTION_KEY: 'cd'.repeat(32),
  STATEKEEP_REMOTE_URL: `http://127.0.0.1:${PY_PORT}/statekeep`, STATEKEEP_REMOTE_SECRET: SECRET,
  STATEKEEP_REMOTE_TIMEOUT_MS: '1500', LOG_DIR: join(dir, 'logs'), STATEKEEP_DATA_DIR: join(dir, 'data'),
};
delete env.STATEKEEP_API_KEY;
const pyEnv = { ...process.env, PORT: String(PY_PORT), STATEKEEP_REMOTE_SECRET: SECRET };

const j = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const waitFor = async (fn, ms = 10_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

const LOAN = {
  id: 'rl', initial: 'review',
  states: {
    review:        { on: { APPROVE: [{ target: 'approved', guard: 'isCreditOk' }, { target: 'manual_review' }] } },
    approved:      { entry: ['sendOffer'], on: { OFFER_SENT: 'offered' } },
    offered:       {},
    manual_review: {},
  },
};

before(async () => {
  py = spawn('python3', ['examples/remote-python/service.py'], { env: pyEnv, stdio: 'ignore' });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${PY_PORT}/statekeep/_calls`)).ok; } catch { return false; } });
  server = spawn(process.execPath, ['src/api/server.js'], { env, stdio: 'ignore' });
  await waitFor(async () => { try { return (await fetch(`${BASE}/v1/health`)).ok; } catch { return false; } });
});
after(() => { server?.kill('SIGKILL'); py?.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });

test('unknown remote name is rejected at deploy (manifest-based typo check)', async () => {
  const bad = { ...LOAN, states: { ...LOAN.states, review: { on: { APPROVE: [{ target: 'approved', guard: 'isCreditOkk' }] } } } };
  const r = await j('PUT', '/v1/definitions', { id: 'rl-typo', definition: bad });
  assert.equal(r.status, 422);
  assert.deepEqual(r.body.missing, ['isCreditOkk']);
});

test('remote guard decides the branch; remote action feeds its result back', async () => {
  assert.equal((await j('PUT', '/v1/definitions', { id: 'rl-v1', definition: LOAN })).status, 201);
  const small = (await j('POST', '/v1/actors', { definitionId: 'rl-v1', initialContext: { amount: 250000 } })).body.id;
  const large = (await j('POST', '/v1/actors', { definitionId: 'rl-v1', initialContext: { amount: 5000000 } })).body.id;
  assert.equal((await j('POST', `/v1/actors/${small}/event`, { type: 'APPROVE' })).body.stateValue, 'approved');
  assert.equal((await j('POST', `/v1/actors/${large}/event`, { type: 'APPROVE' })).body.stateValue, 'manual_review');
  assert.ok(await waitFor(async () => (await j('GET', `/v1/actors/${small}`)).body.stateValue === 'offered'),
    'follow-up OFFER_SENT from the Python action should arrive');
  assert.match((await j('GET', `/v1/actors/${small}`)).body.context.offerId, /^OFF-/);
});

test('service down: remote guard evaluates to false (fails closed)', async () => {
  py.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  const id = (await j('POST', '/v1/actors', { definitionId: 'rl-v1', initialContext: { amount: 1 } })).body.id;
  const r = await j('POST', `/v1/actors/${id}/event`, { type: 'APPROVE' });
  assert.equal(r.status, 200);
  assert.equal(r.body.stateValue, 'manual_review');
});
