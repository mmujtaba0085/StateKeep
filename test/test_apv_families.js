/**
 * test/test_apv_families.js — deployments of one workflow must reach its actors even when
 * other workflows deploy in between, and after a server restart.
 *
 * Found by the workflow chaos simulation: the engine's change-point registry is global, so
 * the first change-point it found could belong to another workflow; that answer was
 * discarded and the actor stayed on its old version.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedPostgres } from './helpers/isolatedDb.js';

const PORT = 3122, BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'sk-apvfam-'));
let server, pg;
const env = {
  ...process.env, PORT: String(PORT), NODE_ENV: 'test', HOST: '127.0.0.1',
  STATEKEEP_DB_PATH: join(dir, 'a.db'), STATEKEEP_ENCRYPTION_KEY: '5d'.repeat(32),
  STATEKEEP_ADMIN_KEY: 'apv-families-admin-key-1234', LOG_DIR: join(dir, 'logs'), STATEKEEP_DATA_DIR: join(dir, 'data'),
};
delete env.STATEKEEP_API_KEY;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const j = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
async function startServer() {
  server = spawn(process.execPath, ['src/api/server.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/v1/health`)).ok) return; } catch {} await sleep(150); }
  throw new Error('server did not start');
}
const machine = (id, extra = {}) => ({ id, initial: 'a', states: { a: { on: { GO: 'b' } }, b: { on: { GO: 'a' } }, ...extra } });
const deploy = (id, def, parentId) => j('PUT', '/v1/definitions', { id, definition: def, ...(parentId ? { parentId } : {}) });

before(async () => {
  pg = await isolatedPostgres('apv_families');
  if (pg) env.STATEKEEP_DB_URL = pg;
  await startServer();
});
after(async () => { server?.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });

test('a deployment reaches an actor although another workflow deployed in between', async () => {
  assert.equal((await deploy('fam-a-v1', machine('fam_a'))).status, 201);
  assert.equal((await deploy('fam-b-v1', machine('fam_b'))).status, 201);
  const actor = (await j('POST', '/v1/actors', { definitionId: 'fam-a-v1' })).body;   // family id: newest version
  assert.equal(actor.definitionId, 'fam-a-v1');
  await j('POST', `/v1/actors/${actor.id}/event`, { type: 'GO' });
  // another workflow deploys first, then ours
  assert.equal((await deploy('fam-b-v2', machine('fam_b', { c: {} }), 'fam-b-v1')).status, 201);
  assert.equal((await deploy('fam-a-v2', machine('fam_a', { c: {} }), 'fam-a-v1')).status, 201);
  const r = await j('POST', `/v1/actors/${actor.id}/event`, { type: 'GO' });
  assert.equal(r.status, 200);
  assert.equal((await j('GET', `/v1/actors/${actor.id}`)).body.definitionId, 'fam-a-v2');
});

test('after a restart, a new deployment still reaches actors spawned before it', async () => {
  const actor = (await j('POST', '/v1/actors', { definitionId: 'fam-a-v1' })).body;
  for (let i = 0; i < 20; i++) await j('POST', `/v1/actors/${actor.id}/event`, { type: 'GO' });   // advance the clock
  server.kill('SIGKILL'); await sleep(300); await startServer();
  assert.equal((await deploy('fam-a-v3', machine('fam_a', { c: {}, d: {} }), 'fam-a-v2')).status, 201);
  await j('POST', `/v1/actors/${actor.id}/event`, { type: 'GO' });
  assert.equal((await j('GET', `/v1/actors/${actor.id}`)).body.definitionId, 'fam-a-v3');
});
