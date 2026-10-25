/**
 * test/cluster/cluster.test.js — two API servers, one Postgres. Needs STATEKEEP_DB_URL
 * (postgres://…) pointing at an EMPTY database; skipped otherwise.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = process.env.STATEKEEP_DB_URL ?? '';
const skip = !DB.startsWith('postgres') && 'needs STATEKEEP_DB_URL=postgres://… (empty database)';
const ADMIN = 'cluster-admin-key-123456';
const dir = mkdtempSync(join(tmpdir(), 'sk-cluster-'));
const nodes = {};

function startNode(name, port, extraEnv = {}) {
  mkdirSync(join(dir, `${name}-hooks`), { recursive: true });
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
    STATEKEEP_TEST_HOOK_DIR: join(dir, `${name}-hooks`),
    STATEKEEP_DB_URL: DB, STATEKEEP_ENCRYPTION_KEY: '12'.repeat(32), STATEKEEP_ADMIN_KEY: ADMIN,
    STATEKEEP_CLUSTER: 'true', STATEKEEP_NODE_ID: name, STATEKEEP_NODE_URL: `http://127.0.0.1:${port}`,
    STATEKEEP_NODE_TTL_MS: '2000', LOG_DIR: join(dir, name), STATEKEEP_DATA_DIR: join(dir, name) };
  Object.assign(env, extraEnv);
  delete env.STATEKEEP_API_KEY;
  nodes[name] = { proc: spawn(process.execPath, ['src/api/server.js'], { env, stdio: process.env.CLUSTER_TEST_LOGS ? ['ignore', openSync(join(dir, `${name}.log`), 'a'), openSync(join(dir, `${name}.log`), 'a')] : 'ignore' }), base: `http://127.0.0.1:${port}` };
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
after(() => { for (const n of Object.values(nodes)) n.proc.kill('SIGKILL'); if (!process.env.CLUSTER_TEST_LOGS) rmSync(dir, { recursive: true, force: true }); });

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

test('a preview made through one server is confirmed through another (tokens in the database)', { skip }, async () => {
  const def = (x = {}) => ({ id: 'cfx', initial: 'a', states: { a: { on: { T: 'b' } }, ...x } });
  assert.equal((await call(nodes.A, 'PUT', '/v1/definitions', { id: 'cfx-v1', definition: def({ b: {} }) })).status, 201);
  const id = (await call(nodes.A, 'POST', '/v1/actors', { definitionId: 'cfx-v1' })).body.id;
  await call(nodes.A, 'POST', `/v1/actors/${id}/event`, { type: 'T' });
  const p = await call(nodes.A, 'PUT', '/v1/definitions', { id: 'cfx-v2', parentId: 'cfx-v1', definition: def({ c: {}, a: { on: { T: 'c' } } }) });
  assert.equal(p.body.status, 'requires_confirmation');
  const ok = await call(nodes.B, 'PUT', '/v1/definitions', { id: 'cfx-v2', parentId: 'cfx-v1', definition: def({ c: {}, a: { on: { T: 'c' } } }), confirmToken: p.body.confirmToken });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await call(nodes.A, 'GET', `/v1/actors/${id}`)).body.status, 'needs_rescue');
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

// ── Deterministic pauses (src/lib/testHooks.js) ────────────────────────────────
// A server is frozen (whole process, like SIGSTOP) at an exact point inside an event unit.
const hook = (name, point) => join(dir, `${name}-hooks`, point);
async function freezeAt(name, point, start) {
  writeFileSync(`${hook(name, point)}.arm`, '');
  const pending = start();
  for (let i = 0; i < 200 && !existsSync(`${hook(name, point)}.paused`); i++) await sleep(25);
  assert.ok(existsSync(`${hook(name, point)}.paused`), `${name} reached ${point}`);
  return { pending };   // wrapped: returning the promise itself would wait for it
}
const release = (name, point) => writeFileSync(`${hook(name, point)}.release`, '');
const pzDef = (fam, extra = {}) => ({ id: fam, initial: 'a', states: { a: { on: { T: 'b' } }, b: { on: { T: 'a' } }, ...extra } });

/** Actor on `owner` with history [T]; `owner` frozen before routing its next event; a
 *  history-targeted deployment for [T] made through A meanwhile; then `owner` released. */
async function deployWhileFrozen(owner, fam, point) {
  assert.equal((await call(nodes.A, 'PUT', '/v1/definitions', { id: `${fam}-v1`, definition: pzDef(fam) })).status, 201);
  const id = (await call(nodes[owner], 'POST', '/v1/actors', { definitionId: `${fam}-v1` })).body.id;
  assert.equal((await call(nodes[owner], 'POST', `/v1/actors/${id}/event`, { type: 'T' })).status, 200);
  const { pending } = await freezeAt(owner, point, () => call(nodes[owner], 'POST', `/v1/actors/${id}/event`, { type: 'T' }));
  let d;
  try {
    // The owner is frozen: it cannot acknowledge, sync or heartbeat. The deployment returns
    // after its bounded wait, as committed.
    d = await call(nodes.A, 'PUT', '/v1/definitions', { id: `${fam}-v2`, parentId: `${fam}-v1`, historyPath: ['T'], definition: pzDef(fam, { z: {} }) });
    await sleep(2600);                                 // well past the old 2 s lease
  } finally { release(owner, point); }
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const r = await pending;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = (await call(nodes.A, 'GET', `/v1/actors/${id}`)).body;
  const ev = await call(nodes.A, 'GET', `/v1/actors/${id}/events?limit=100`);
  return { a, ts: ev.body.events.filter((e) => (e.eventType ?? e.type) === 'T').length, fam };
}

test('an event that reaches routing after a deployment committed is routed with it, however long its server was frozen', { skip }, async () => {
  // Frozen BEFORE the registry check: the deployment committed before this unit read the
  // registry epoch, so the unit must see it and move the actor first (no clock involved).
  const r = await deployWhileFrozen('B', 'pzf', 'unit-before-registry-check');
  assert.equal(r.a.definitionId, 'pzf-v2', 'routed with the deployment made while the server was frozen');
  assert.equal(r.ts, 2, 'each confirmed event applied once');
});

test('control: the same scenario with the registry fence disabled routes with a stale registry (the test above detects a missing fence)', { skip }, async () => {
  startNode('C', 3063, { STATEKEEP_TEST_DISABLE_REGISTRY_FENCE: '1' }); await up(nodes.C);
  try {
    const r = await deployWhileFrozen('C', 'pzc', 'unit-before-registry-check');
    assert.equal(r.a.definitionId, 'pzc-v1', 'without the fence the frozen server routes on its old registry');
    assert.equal(r.ts, 2);
  } finally { nodes.C.proc.kill('SIGKILL'); delete nodes.C; }
});

test('an event that passed the registry check before a deployment is ordered before it (no lost or doubled event)', { skip }, async () => {
  // Frozen AFTER the check: the unit read the epoch before the deployment committed, so it
  // is linearized before it — the event is processed on v1 (history becomes [T, T], which
  // no longer matches [T]). That is the outcome of "the event arrived just before the
  // deployment", applied exactly once.
  const r = await deployWhileFrozen('B', 'pza', 'unit-after-registry-check');
  assert.equal(r.a.definitionId, 'pza-v1');
  assert.equal(r.ts, 2);
});

// ── Ownership fencing (src/cluster/ownership.js) ───────────────────────────────
/** Actor owned by `owner` with one T applied; `owner` frozen at `point` while handling a
 *  second T; after its heartbeat expired, three Ts through `other` (which takes over);
 *  then `owner` is released. Returns the frozen request's answer, the number of T events
 *  in the log and the final state. */
async function takeoverWhileFrozen(owner, other, fam, point, { releaseAfterMs = 0 } = {}) {
  assert.equal((await call(nodes.A, 'PUT', '/v1/definitions', { id: `${fam}-v1`, definition: pzDef(fam) })).status, 201);
  const id = (await call(nodes[owner], 'POST', '/v1/actors', { definitionId: `${fam}-v1` })).body.id;
  assert.equal((await call(nodes[owner], 'POST', `/v1/actors/${id}/event`, { type: 'T' })).status, 200);
  const { pending } = await freezeAt(owner, point, () => call(nodes[owner], 'POST', `/v1/actors/${id}/event`, { type: 'T' }));
  const others = [];
  try {
    await sleep(2600);                                   // past the 2 s heartbeat TTL: "dead"
    if (releaseAfterMs) {
      // The takeover must wait for the frozen server's flush (it holds the ownership row).
      const first = call(nodes[other], 'POST', `/v1/actors/${id}/event`, { type: 'T' });
      await sleep(releaseAfterMs);
      release(owner, point);
      others.push(await first);
    } else {
      for (let k = 0; k < 3; k++) others.push(await call(nodes[other], 'POST', `/v1/actors/${id}/event`, { type: 'T' }));
    }
  } finally { release(owner, point); }
  const frozen = await pending;
  await sleep(300);
  const ev = await call(nodes[other], 'GET', `/v1/actors/${id}/events?limit=100`);
  const ts = ev.body.events.filter((e) => (e.eventType ?? e.type) === 'T').length;
  const state = (await call(nodes[other], 'GET', `/v1/actors/${id}`)).body.stateValue;
  return { frozen, others, ts, state };
}
const parity = (n) => (n % 2 ? 'b' : 'a');               // a, toggled by T

test('a server frozen mid-event and taken over cannot commit from its stale cache (ownership generation)', { skip }, async () => {
  const r = await takeoverWhileFrozen('A', 'B', 'own1', 'unit-before-registry-check');
  assert.ok(r.others.every((x) => x.status === 200 && x.servedBy === 'B'), 'B took the actor over');
  assert.equal(r.frozen.status, 503, JSON.stringify(r.frozen.body));
  assert.equal(r.frozen.body.code, 'OWNER_CHANGED');
  assert.equal(r.ts, 4, 'the refused event is not in the log');
  assert.equal(r.state, parity(4), 'state matches the log: nothing lost or overwritten');
});

test('control: with the ownership fence disabled the same scenario loses an update (the test above detects a missing fence)', { skip }, async () => {
  startNode('D', 3064, { STATEKEEP_TEST_DISABLE_OWNER_FENCE: '1' }); await up(nodes.D);
  try {
    const r = await takeoverWhileFrozen('D', 'B', 'own2', 'unit-before-registry-check');
    assert.equal(r.frozen.status, 200, 'without the fence the stale server acknowledges');
    assert.equal(r.ts, 5);
    assert.notEqual(r.state, parity(5), 'and its stale write overwrote the new owner\'s state');
  } finally { nodes.D.proc.kill('SIGKILL'); delete nodes.D; }
});

test('a takeover waits for a flush that already passed the ownership check, then sees its write', { skip }, async () => {
  const r = await takeoverWhileFrozen('A', 'B', 'own3', 'flush-after-owner-check', { releaseAfterMs: 800 });
  assert.equal(r.frozen.status, 200, 'the frozen flush commits: it held the ownership row');
  assert.equal(r.others[0].status, 200, JSON.stringify(r.others[0].body));
  assert.equal(r.ts, 3);
  assert.equal(r.state, parity(3));
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
