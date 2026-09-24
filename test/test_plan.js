/**
 * test/test_plan.js — `statekeep plan`: what a release would do to running actors,
 * without deploying. Starts its own server.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planRelease, renderMarkdown, PLAN_MARKER } from '../src/cli/plan.js';

const PORT = 3091, BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'sk-plan-'));
const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'test', HOST: '127.0.0.1',
  STATEKEEP_DB_PATH: join(dir, 'p.db'), STATEKEEP_ENCRYPTION_KEY: 'aa'.repeat(32),
  LOG_DIR: join(dir, 'logs'), STATEKEEP_DATA_DIR: join(dir, 'data') };
delete env.STATEKEEP_API_KEY; delete env.STATEKEEP_DB_URL; delete env.STATEKEEP_REMOTE_URL;
let server;
const j = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

const V1 = { id: 'tk', initial: 'open', states: { open: { on: { WORK: 'working' } }, working: { on: { DONE: 'closed', WAIT: 'on_hold' } }, on_hold: { on: { RESUME: 'working' } }, closed: { type: 'final' } } };
const V2 = { id: 'tk', initial: 'open', states: { open: { on: { WORK: 'working' } }, working: { on: { DONE: 'review', WAIT: 'paused' } }, paused: { on: { RESUME: 'working' } }, review: { on: { OK: 'closed' } }, closed: { type: 'final' } } };

before(async () => {
  server = spawn(process.execPath, ['src/api/server.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/v1/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  await j('PUT', '/v1/definitions', { id: 'tk-v1', definition: V1 });
  for (const path of [[], ['WORK'], ['WORK', 'WAIT'], ['WORK', 'WAIT']]) {
    const id = (await j('POST', '/v1/actors', { definitionId: 'tk-v1' })).body.id;
    for (const e of path) await j('POST', `/v1/actors/${id}/event`, { type: e });
  }
});
after(() => { server?.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });

test('flags stranded actors and suggests a stateMapping', async () => {
  const r = await planRelease({ id: 'tk-v2', parentId: 'tk-v1', definition: V2 }, { baseUrl: BASE });
  assert.equal(r.verdict, 'stranded');
  assert.deepEqual(r.stranded, [{ state: 'on_hold', count: 2 }]);
  assert.equal(r.moves, 2, 'the two actors not in on_hold can move');
  assert.deepEqual(r.added.sort(), ['paused', 'review']);
  assert.deepEqual(r.removed, ['on_hold']);
  const md = renderMarkdown([r]);
  assert.ok(md.startsWith(PLAN_MARKER));
  assert.match(md, /stateMapping/);
});

test('safe once the mapping is added; nothing is deployed by planning', async () => {
  const r = await planRelease({ id: 'tk-v2', parentId: 'tk-v1', definition: V2, stateMapping: { on_hold: 'paused' } }, { baseUrl: BASE });
  assert.equal(r.verdict, 'safe');
  assert.equal(r.moves, 4);
  assert.equal((await j('GET', '/v1/definitions/tk-v2')).status, 404, 'plan must not deploy');
});

test('new machine and missing parent', async () => {
  assert.equal((await planRelease({ id: 'x-v1', definition: V1 }, { baseUrl: BASE })).kind, 'new');
  assert.equal((await planRelease({ id: 'x-v2', parentId: 'nope-v1', definition: V1 }, { baseUrl: BASE })).verdict, 'error');
});
