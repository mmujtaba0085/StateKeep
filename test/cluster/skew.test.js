/**
 * test/cluster/skew.test.js — three servers whose clocks disagree.
 *
 *   A  correct clock
 *   B  5 minutes behind, running slow (rate 0.8)
 *   C  5 minutes ahead,  running fast (rate 1.25)
 *
 * (test/helpers/skewClock.mjs skews Date.now, new Date(), performance.now and timer rates
 * of a whole process, its workers included.) Correctness — routing and ownership — uses
 * no clock (registry epoch, ownership generations), so it must hold unchanged, including
 * for frozen servers. Time-based work — after: timers, action-job leases — uses the
 * database time line (src/lib/clusterClock.js), so a timer fires on time whichever
 * server created it and whichever server's scheduler picks it up.
 *
 *   STATEKEEP_DB_URL=postgres://…/<empty db> node --test test/cluster/skew.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DB = process.env.STATEKEEP_DB_URL ?? '';
const skip = !DB.startsWith('postgres') && 'needs STATEKEEP_DB_URL=postgres://… (empty database)';
const ADMIN = 'cluster-admin-key-123456';
const SKEW = resolve('test/helpers/skewClock.mjs');
const dir = mkdtempSync(join(tmpdir(), 'sk-skew-'));
const nodes = {};
const CLOCKS = {
  A: { port: 3081 },
  B: { port: 3082, offset: -300000, rate: 0.8 },
  C: { port: 3083, offset: +300000, rate: 1.25 },
};

function startNode(name) {
  const { port, offset = 0, rate = 1 } = CLOCKS[name];
  mkdirSync(join(dir, `${name}-hooks`), { recursive: true });
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
    STATEKEEP_TEST_HOOK_DIR: join(dir, `${name}-hooks`),
    STATEKEEP_DB_URL: DB, STATEKEEP_ENCRYPTION_KEY: '12'.repeat(32), STATEKEEP_ADMIN_KEY: ADMIN,
    STATEKEEP_CLUSTER: 'true', STATEKEEP_NODE_ID: name, STATEKEEP_NODE_URL: `http://127.0.0.1:${port}`,
    STATEKEEP_NODE_TTL_MS: '3000', SCHEDULER_POLL_INTERVAL: '200', STATEKEEP_CLOCK_RESYNC_MS: '1000',
    LOG_DIR: join(dir, name), STATEKEEP_DATA_DIR: join(dir, name),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${SKEW}`.trim(),
    SK_CLOCK_OFFSET_MS: String(offset), SK_CLOCK_RATE: String(rate) };
  delete env.STATEKEEP_API_KEY;
  const out = process.env.CLUSTER_TEST_LOGS ? openSync(join(dir, `${name}.log`), 'a') : 'ignore';
  nodes[name] = { proc: spawn(process.execPath, ['src/api/server.js'], { env, stdio: ['ignore', out, out] }), base: `http://127.0.0.1:${port}` };
  // its scheduler (fires after: timers), on the same skewed clock
  nodes[`${name}-scheduler`] = { proc: spawn(process.execPath, ['src/workers/scheduler-worker.js'],
    { env: { ...env, STATEKEEP_INTERNAL_URL: `http://127.0.0.1:${port}` }, stdio: ['ignore', out, out] }) };
  return nodes[name];
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const up = async (n) => { for (let i = 0; i < 80; i++) { try { if ((await fetch(`${n.base}/v1/health`)).ok) return; } catch {} await sleep(250); } throw new Error('node did not start'); };
const call = async (n, method, path, body) => {
  const r = await fetch(n.base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  return { status: r.status, servedBy: r.headers.get('x-statekeep-served-by'), body: await r.json().catch(() => ({})) };
};
const hook = (name, point) => join(dir, `${name}-hooks`, point);
async function freezeAt(name, point, start) {
  writeFileSync(`${hook(name, point)}.arm`, '');
  const pending = start();
  for (let i = 0; i < 200 && !existsSync(`${hook(name, point)}.paused`); i++) await sleep(25);
  assert.ok(existsSync(`${hook(name, point)}.paused`), `${name} reached ${point}`);
  return { pending };
}
const release = (name, point) => writeFileSync(`${hook(name, point)}.release`, '');
const toggle = (fam, extra = {}) => ({ id: fam, initial: 'a', states: { a: { on: { T: 'b' } }, b: { on: { T: 'a' } }, ...extra } });
const Ts = async (n, id) => (await call(n, 'GET', `/v1/actors/${id}/events?limit=200`)).body.events.filter((e) => (e.eventType ?? e.type) === 'T').length;

before(async () => {
  if (skip) return;
  startNode('A'); await up(nodes.A);
  startNode('B'); await up(nodes.B);
  startNode('C'); await up(nodes.C);
});
after(() => { for (const n of Object.values(nodes)) n.proc.kill('SIGKILL'); if (!process.env.CLUSTER_TEST_LOGS) rmSync(dir, { recursive: true, force: true }); });

test('no lost updates across servers with skewed clocks', { skip }, async () => {
  assert.equal((await call(nodes.A, 'PUT', '/v1/definitions', { id: 'sk1-v1', definition: toggle('sk1') })).status, 201);
  for (const owner of ['A', 'B', 'C']) {
    const id = (await call(nodes[owner], 'POST', '/v1/actors', { definitionId: 'sk1-v1' })).body.id;
    const order = ['A', 'B', 'C'];
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => call(nodes[order[i % 3]], 'POST', `/v1/actors/${id}/event`, { type: 'T' })));
    assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.find((r) => r.status !== 200)?.body));
    assert.equal(await Ts(nodes.A, id), 30);
    assert.equal((await call(nodes.C, 'GET', `/v1/actors/${id}`)).body.stateValue, 'a');
  }
});

test('a deployment through any server routes the next event on every server', { skip }, async () => {
  for (const deployer of ['A', 'B', 'C']) {
    const fam = `sk2${deployer.toLowerCase()}`;
    assert.equal((await call(nodes.A, 'PUT', '/v1/definitions', { id: `${fam}-v1`, definition: toggle(fam) })).status, 201);
    const ids = {};
    for (const owner of ['A', 'B', 'C']) {
      ids[owner] = (await call(nodes[owner], 'POST', '/v1/actors', { definitionId: `${fam}-v1` })).body.id;
      await call(nodes[owner], 'POST', `/v1/actors/${ids[owner]}/event`, { type: 'T' });
    }
    const d = await call(nodes[deployer], 'PUT', '/v1/definitions', { id: `${fam}-v2`, parentId: `${fam}-v1`, historyPath: ['T'], definition: toggle(fam, { z: {} }) });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    for (const owner of ['A', 'B', 'C']) {
      assert.equal((await call(nodes[owner], 'POST', `/v1/actors/${ids[owner]}/event`, { type: 'T' })).status, 200);
      assert.equal((await call(nodes.A, 'GET', `/v1/actors/${ids[owner]}`)).body.definitionId, `${fam}-v2`, `deployed via ${deployer}, owner ${owner}`);
    }
    // a spawn after the deployment, on any server, starts on the newest version's mainline
    for (const s of ['A', 'B', 'C']) {
      const a = (await call(nodes[s], 'POST', '/v1/actors', { definitionId: `${fam}-v1` })).body;
      assert.ok(a.id, JSON.stringify(a));
    }
  }
});

test('a frozen server with a skewed clock still routes with a deployment committed while it was frozen', { skip }, async () => {
  for (const owner of ['B', 'C']) {
    const fam = `sk3${owner.toLowerCase()}`;
    assert.equal((await call(nodes.A, 'PUT', '/v1/definitions', { id: `${fam}-v1`, definition: toggle(fam) })).status, 201);
    const id = (await call(nodes[owner], 'POST', '/v1/actors', { definitionId: `${fam}-v1` })).body.id;
    await call(nodes[owner], 'POST', `/v1/actors/${id}/event`, { type: 'T' });
    const { pending } = await freezeAt(owner, 'unit-before-registry-check', () => call(nodes[owner], 'POST', `/v1/actors/${id}/event`, { type: 'T' }));
    let d;
    try {
      d = await call(nodes.A, 'PUT', '/v1/definitions', { id: `${fam}-v2`, parentId: `${fam}-v1`, historyPath: ['T'], definition: toggle(fam, { z: {} }) });
      await sleep(1500);
    } finally { release(owner, 'unit-before-registry-check'); }
    assert.equal(d.status, 201);
    assert.equal((await pending).status, 200);
    assert.equal((await call(nodes.A, 'GET', `/v1/actors/${id}`)).body.definitionId, `${fam}-v2`);
    assert.equal(await Ts(nodes.A, id), 2);
  }
});

test('a frozen server with a skewed clock that was taken over cannot commit from its stale cache', { skip }, async () => {
  for (const [owner, other] of [['B', 'C'], ['C', 'B']]) {
    const fam = `sk4${owner.toLowerCase()}`;
    assert.equal((await call(nodes.A, 'PUT', '/v1/definitions', { id: `${fam}-v1`, definition: toggle(fam) })).status, 201);
    const id = (await call(nodes[owner], 'POST', '/v1/actors', { definitionId: `${fam}-v1` })).body.id;
    await call(nodes[owner], 'POST', `/v1/actors/${id}/event`, { type: 'T' });
    const { pending } = await freezeAt(owner, 'unit-before-registry-check', () => call(nodes[owner], 'POST', `/v1/actors/${id}/event`, { type: 'T' }));
    const others = [];
    try {
      await sleep(3800);                                   // past the 3 s TTL (database clock)
      for (let k = 0; k < 3; k++) others.push(await call(nodes[other], 'POST', `/v1/actors/${id}/event`, { type: 'T' }));
    } finally { release(owner, 'unit-before-registry-check'); }
    const frozen = await pending;
    assert.ok(others.every((r) => r.status === 200 && r.servedBy === other), JSON.stringify(others.map((r) => [r.status, r.servedBy])));
    assert.equal(frozen.status, 503);
    assert.equal(frozen.body.code, 'OWNER_CHANGED');
    await sleep(300);
    assert.equal(await Ts(nodes.A, id), 4);
    assert.equal((await call(nodes.A, 'GET', `/v1/actors/${id}`)).body.stateValue, 'a');
  }
});

test('after: timers fire on time whichever server created them', { skip }, async () => {
  const DELAY = 4000;
  const def = { id: 'sk5', initial: 'wait', states: { wait: { after: { [DELAY]: 'done' } }, done: {} } };
  assert.equal((await call(nodes.A, 'PUT', '/v1/definitions', { id: 'sk5-v1', definition: def })).status, 201);
  const t0 = performance.now();
  const ids = {};
  for (const s of ['A', 'B', 'C']) ids[s] = (await call(nodes[s], 'POST', '/v1/actors', { definitionId: 'sk5-v1' })).body.id;
  const firedAt = {};
  while (performance.now() - t0 < DELAY + 8000 && Object.keys(firedAt).length < 3) {
    for (const s of ['A', 'B', 'C']) {
      if (firedAt[s] != null) continue;
      const a = (await call(nodes.A, 'GET', `/v1/actors/${ids[s]}`)).body;
      if (a.stateValue === 'done') firedAt[s] = Math.round(performance.now() - t0);
    }
    await sleep(100);
  }
  // Without the shared time line C's timer fired at once (5 min early) and B's 5 min late.
  for (const s of ['A', 'B', 'C']) {
    assert.ok(firedAt[s] != null, `timer created on ${s} fired (${JSON.stringify(firedAt)})`);
    assert.ok(firedAt[s] >= DELAY - 1500, `timer created on ${s} not early: ${firedAt[s]} ms`);
    assert.ok(firedAt[s] <= DELAY + 4000, `timer created on ${s} not late: ${firedAt[s]} ms`);
  }
});
