/**
 * test/cluster/cluster.test.js — two API servers, one Postgres. Needs STATEKEEP_DB_URL
 * (postgres://…) pointing at an EMPTY database; skipped otherwise.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = process.env.STATEKEEP_DB_URL ?? '';
const skip = !DB.startsWith('postgres') && 'needs STATEKEEP_DB_URL=postgres://… (empty database)';
const ADMIN = 'cluster-admin-key-123456';
const dir = mkdtempSync(join(tmpdir(), 'sk-cluster-'));
const nodes = {};

function startNode(name, port) {
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
    STATEKEEP_DB_URL: DB, STATEKEEP_ENCRYPTION_KEY: '12'.repeat(32), STATEKEEP_ADMIN_KEY: ADMIN,
    STATEKEEP_CLUSTER: 'true', STATEKEEP_NODE_ID: name, STATEKEEP_NODE_URL: `http://127.0.0.1:${port}`,
    STATEKEEP_NODE_TTL_MS: '2000', LOG_DIR: join(dir, name), STATEKEEP_DATA_DIR: join(dir, name) };
  delete env.STATEKEEP_API_KEY;
  nodes[name] = { proc: spawn(process.execPath, ['src/api/server.js'], { env, stdio: 'ignore' }), base: `http://127.0.0.1:${port}` };
  return nodes[name];
}
const up = async (n) => { for (let i = 0; i < 80; i++) { try { if ((await fetch(`${n.base}/v1/health`)).ok) return; } catch {} await new Promise((r) => { setTimeout(r, 250); }); } throw new Error('node did not start'); };
const call = async (n, method, path, body) => {
  const r = await fetch(n.base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, servedBy: r.headers.get('x-statekeep-served-by'), body: await r.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

before(async () => {
  if (skip) return;
  startNode('A', 3061); await up(nodes.A);          // A bootstraps the schema first
  startNode('B', 3062); await up(nodes.B);
  await call(nodes.A, 'PUT', '/v1/definitions', { id: 'ping-v1', definition: { id: 'ping', initial: 'a', states: { a: { on: { T: 'b' } }, b: { on: { T: 'a' } } } } });
});
after(() => { for (const n of Object.values(nodes)) n.proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });

test('requests to a non-owner are forwarded to the owner; no lost updates', { skip }, async () => {
  const id = (await call(nodes.A, 'POST', '/v1/actors', { definitionId: 'ping-v1' })).body.id;
  const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => call(i % 2 ? nodes.B : nodes.A, 'POST', `/v1/actors/${id}/event`, { type: 'T' })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.ok(rs.filter((_, i) => i % 2).every((r) => r.servedBy === 'A'), 'B forwards to the owner A');
  const ev = await call(nodes.B, 'GET', `/v1/actors/${id}/events?limit=100`);
  assert.equal(ev.body.events.filter((e) => (e.eventType ?? e.type) === 'T').length, 40);
  assert.equal((await call(nodes.B, 'GET', `/v1/actors/${id}`)).body.stateValue, 'a', '40 toggles → back to a');
});

test('idempotency holds across servers', { skip }, async () => {
  const id = (await call(nodes.B, 'POST', '/v1/actors', { definitionId: 'ping-v1' })).body.id;
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => call(i % 2 ? nodes.B : nodes.A, 'POST', `/v1/actors/${id}/event`, { type: 'T', idempotencyKey: 'x1' })));
  assert.equal(rs.filter((r) => r.status === 200 && !r.body.idempotent).length, 1);
  assert.equal((await call(nodes.A, 'GET', `/v1/actors/${id}`)).body.stateValue, 'b');
});

test('a deployment is visible on every server when it returns (registry barrier)', { skip }, async () => {
  // Actors owned by B, history [T]; a history-targeted deployment made through A must
  // route them on their very next event (before: B saw it only at its next 500 ms poll,
  // so an event arriving first moved the history past the pattern and the actor was missed).
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = (await call(nodes.B, 'POST', '/v1/actors', { definitionId: 'ping-v1' })).body.id;
    await call(nodes.B, 'POST', `/v1/actors/${id}/event`, { type: 'T' });
    ids.push(id);
  }
  for (let round = 2; round <= 4; round++) {
    const parent = round === 2 ? 'ping-v1' : `ping-bar-v${round - 1}`;
    const d = await call(nodes.A, 'PUT', '/v1/definitions', { id: `ping-bar-v${round}`, parentId: parent,
      historyPath: Array(round - 1).fill('T'),
      definition: { id: 'ping', initial: 'a', states: { a: { on: { T: 'b' } }, b: { on: { T: 'a' } }, [`z${round}`]: {} } } });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.deepEqual(d.body.visibility.unacknowledged, []);
    const rs = await Promise.all(ids.map((id) => call(nodes.A, 'POST', `/v1/actors/${id}/event`, { type: 'T' })));
    assert.ok(rs.every((r) => r.status === 200 && r.servedBy === 'B'));
    for (const id of ids) assert.equal((await call(nodes.A, 'GET', `/v1/actors/${id}`)).body.definitionId, `ping-bar-v${round}`);
  }
});

test('WebSocket subscribers on another server receive changes (LISTEN/NOTIFY)', { skip: skip || (typeof WebSocket === 'undefined' && 'no global WebSocket') }, async () => {
  const id = (await call(nodes.A, 'POST', '/v1/actors', { definitionId: 'ping-v1' })).body.id;
  const ws = new WebSocket(`ws://127.0.0.1:3062/v1/actors/${id}/stream`);
  const got = [];
  ws.onmessage = (m) => got.push(JSON.parse(m.data));
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('websocket failed')); setTimeout(() => reject(new Error('websocket open timeout')), 5000); });
  await sleep(300);
  await call(nodes.A, 'POST', `/v1/actors/${id}/event`, { type: 'T' });
  for (let i = 0; i < 20 && !got.some((m) => m.type === 'STATE' && m.stateValue === 'b'); i++) await sleep(100);
  ws.close();
  assert.ok(got.some((m) => m.type === 'STATE' && m.stateValue === 'b'), JSON.stringify(got));
});

test('owner dies mid-stream: the other server takes over with every confirmed event', { skip }, async () => {
  const id = (await call(nodes.A, 'POST', '/v1/actors', { definitionId: 'ping-v1' })).body.id;
  let confirmed = 0;
  for (let i = 0; i < 15; i++) if ((await call(nodes.A, 'POST', `/v1/actors/${id}/event`, { type: 'T' })).status === 200) confirmed++;
  nodes.A.proc.kill('SIGKILL');                                  // owner crashes
  const first = await call(nodes.B, 'POST', `/v1/actors/${id}/event`, { type: 'T' });
  // Either B took over already (heartbeat expired) or asks the client to retry
  let r = first;
  for (let i = 0; i < 30 && r.status !== 200; i++) { await sleep(250); r = await call(nodes.B, 'POST', `/v1/actors/${id}/event`, { type: 'T' }); }
  assert.equal(r.status, 200);
  assert.equal(r.servedBy, 'B');
  confirmed++;
  const ev = await call(nodes.B, 'GET', `/v1/actors/${id}/events?limit=100`);
  assert.equal(ev.body.events.filter((e) => (e.eventType ?? e.type) === 'T').length, confirmed, 'no confirmed event lost across failover');
  assert.equal((await call(nodes.B, 'GET', `/v1/actors/${id}`)).body.stateValue, confirmed % 2 ? 'b' : 'a');
});

test('a restarted server forwards to the new owner instead of using stale state', { skip }, async () => {
  startNode('A', 3061); await up(nodes.A);
  const ids = (await call(nodes.B, 'GET', '/v1/actors?limit=50&definitionId=ping-v1')).body.actors.map((a) => a.id);
  for (const id of ids.slice(-2)) {
    const before = (await call(nodes.B, 'GET', `/v1/actors/${id}`)).body.stateValue;
    const r = await call(nodes.A, 'POST', `/v1/actors/${id}/event`, { type: 'T' });
    assert.equal(r.status, 200);
    assert.notEqual(r.body.stateValue, before, 'transition applied to the current state');
  }
});
