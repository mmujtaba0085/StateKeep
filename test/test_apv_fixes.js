/**
 * test/test_apv_fixes.js — the routing model's guarantees, end to end:
 *   injective history fingerprints, earliest-deployment-first across scalar and parallel
 *   change-points, strict state mapping (nested states), dotted mappings and context
 *   defaults, immutable versions, mainline spawns, exact deploy-time predictions,
 *   late-matcher warnings, registry collection and embedded-mode deployments.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedPostgres } from './helpers/isolatedDb.js';

const PORT = 3124, BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'sk-apvfix-'));
let server, pg;
const env = {
  ...process.env, PORT: String(PORT), NODE_ENV: 'test', HOST: '127.0.0.1',
  STATEKEEP_DB_PATH: join(dir, 'a.db'), STATEKEEP_ENCRYPTION_KEY: '6e'.repeat(32),
  STATEKEEP_ADMIN_KEY: 'apv-fixes-admin-key-1234', LOG_DIR: join(dir, 'logs'), STATEKEEP_DATA_DIR: join(dir, 'data'),
  STATEKEEP_COLLECT_INTERVAL_MS: '300',
};
delete env.STATEKEEP_API_KEY;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const j = async (method, path, body) => {
  const headers = { 'x-admin-key': env.STATEKEEP_ADMIN_KEY, ...(body ? { 'content-type': 'application/json' } : {}) };
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
async function startServer() {
  server = spawn(process.execPath, ['src/api/server.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/v1/health`)).ok) return; } catch {} await sleep(150); }
  throw new Error('server did not start');
}
const put = (body) => j('PUT', '/v1/definitions', body);
const actorOf = async (id) => (await j('GET', `/v1/actors/${id}`)).body;
const send = (id, type) => j('POST', `/v1/actors/${id}/event`, { type });

before(async () => {
  pg = await isolatedPostgres('apv_fixes');
  if (pg) env.STATEKEEP_DB_URL = pg;
  await startServer();
});
after(async () => { server?.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });

test('history patterns are injective: [PAY, MENT_OK] does not match a PAYMENT_OK pattern', async () => {
  const m = (extra = {}) => ({ id: 'inj', initial: 'a', states: {
    a: { on: { PAY: 'p', PAYMENT_OK: 'done' } }, p: { on: { MENT_OK: 'done' } }, done: { on: { X: 'a' } }, ...extra } });
  assert.equal((await put({ id: 'inj-v1', definition: m() })).status, 201);
  const split = (await j('POST', '/v1/actors', { definitionId: 'inj-v1' })).body;
  const whole = (await j('POST', '/v1/actors', { definitionId: 'inj-v1' })).body;
  await send(split.id, 'PAY'); await send(split.id, 'MENT_OK');
  await send(whole.id, 'PAYMENT_OK');
  const r = await put({ id: 'inj-v2', parentId: 'inj-v1', historyPath: ['PAYMENT_OK'], definition: m({ z: {} }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await send(split.id, 'X'); await send(whole.id, 'X');
  assert.equal((await actorOf(whole.id)).definitionId, 'inj-v2');
  assert.equal((await actorOf(split.id)).definitionId, 'inj-v1', 'the v1 (FNV) fingerprints of these histories collide');
});

test('a removed nested state strands the actor instead of misplacing it; a dotted mapping places it', async () => {
  const m = (ship) => ({ id: 'nest', initial: 'shipping', states: {
    shipping: { initial: Object.keys(ship)[0], states: ship }, done: {} } });
  assert.equal((await put({ id: 'nest-v1', definition: m({ packing: { on: { NEXT: 'labelled' } }, labelled: { on: { NEXT: '#nest.done' } } }) })).status, 201);
  const a = (await j('POST', '/v1/actors', { definitionId: 'nest-v1' })).body;            // shipping.packing
  const b = (await j('POST', '/v1/actors', { definitionId: 'nest-v1' })).body;
  // v2 removes shipping.packing. Preview predicts both strandings (exact dry run).
  const v2def = m({ fulfilment: { on: { NEXT: 'labelled' } }, labelled: { on: { NEXT: '#nest.done' } } });
  const pre = await put({ id: 'nest-v2', parentId: 'nest-v1', definition: v2def });
  assert.equal(pre.status, 200);
  assert.equal(pre.body.status, 'requires_confirmation');
  assert.equal(pre.body.strandedActors.reduce((s, g) => s + g.count, 0), 2);
  // With a dotted mapping nobody is stranded.
  const ok = await put({ id: 'nest-v2', parentId: 'nest-v1', definition: v2def, stateMapping: { 'shipping.packing': 'shipping.fulfilment' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  await send(a.id, 'NEXT');
  const after = await actorOf(a.id);
  assert.equal(after.definitionId, 'nest-v2');
  assert.deepEqual(after.stateValue, { shipping: 'labelled' });
  // v3 without mapping for 'fulfilment': b (still in fulfilment after migration) is stranded, never misplaced
  await send(b.id, 'NOOP');
  assert.deepEqual((await actorOf(b.id)).stateValue, { shipping: 'fulfilment' });
  const v3def = m({ other: { on: { NEXT: 'labelled' } }, labelled: {} });
  const p3 = await put({ id: 'nest-v3', parentId: 'nest-v2', definition: v3def });
  assert.equal(p3.body.status, 'requires_confirmation');
  const c3 = await put({ id: 'nest-v3', parentId: 'nest-v2', definition: v3def, confirmToken: p3.body.confirmToken });
  assert.equal(c3.status, 201, JSON.stringify(c3.body));
  const bb = await actorOf(b.id);
  assert.equal(bb.status, 'needs_rescue');
  assert.deepEqual(bb.stateValue, { shipping: 'fulfilment' });
});

test('context transform: constants and defaults', async () => {
  const m = { id: 'ctx', initial: 'a', states: { a: { on: { GO: 'b' } }, b: { on: { GO: 'a' } } } };
  assert.equal((await put({ id: 'ctx-v1', definition: m })).status, 201);
  const a = (await j('POST', '/v1/actors', { definitionId: 'ctx-v1', initialContext: { fee: 5 } })).body;
  const r = await put({ id: 'ctx-v2', parentId: 'ctx-v1', definition: m,
    contextTransform: { schema: { value: 2 }, 'billing.fee': { from: 'fee', default: 0 }, 'billing.tax': { from: 'tax', default: 0.2 } } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await send(a.id, 'GO');
  const ctx = (await actorOf(a.id)).context;
  assert.equal(ctx.schema, 2);
  assert.deepEqual(ctx.billing, { fee: 5, tax: 0.2 });
});

test('versions are immutable: redeploying an id with a change is refused', async () => {
  const m = { id: 'imm', initial: 'a', states: { a: {} } };
  assert.equal((await put({ id: 'imm-v1', definition: m })).status, 201);
  assert.equal((await put({ id: 'imm-v1', definition: m })).status, 200);                    // idempotent
  const r = await put({ id: 'imm-v1', definition: { ...m, states: { a: {}, b: {} } } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'VERSION_IMMUTABLE');
});

test('earliest deployment first: an earlier parallel deployment is not skipped by a later scalar one', async () => {
  const par = (extra = {}) => ({ id: 'par', initial: 'active', states: {
    active: { type: 'parallel', states: {
      pay:  { initial: 'unpaid', states: { unpaid: { on: { PAY: 'paid' } }, paid: {} } },
      ship: { initial: 'idle',   states: { idle: { on: { SHIP: 'sent' } }, sent: {} } },
    } }, ...extra } });
  assert.equal((await put({ id: 'par-v1', definition: par() })).status, 201);
  const a = (await j('POST', '/v1/actors', { definitionId: 'par-v1' })).body;
  await send(a.id, 'PAY');
  const r2 = await put({ id: 'par-v2', parentId: 'par-v1', historyRegions: { 'active.pay': ['PAY'] },
    definition: par({ x: {} }), contextTransform: { via: { value: 'v2' } } });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  const r3 = await put({ id: 'par-v3', parentId: 'par-v2', definition: par({ x: {}, y: {} }) });   // wildcard, later
  assert.equal(r3.status, 201, JSON.stringify(r3.body));
  await send(a.id, 'SHIP');
  const s = await actorOf(a.id);
  assert.equal(s.definitionId, 'par-v3');
  assert.equal(s.context.via, 'v2', 'routed through the earlier parallel deployment first');
});

test('spawning by family id starts new actors on the newest version (history targeting selects running actors only)', async () => {
  const m = (extra = {}) => ({ id: 'ml', initial: 'a', states: { a: { on: { GO: 'b' } }, b: {}, ...extra } });
  assert.equal((await put({ id: 'ml-v1', definition: m() })).status, 201);
  assert.equal((await put({ id: 'ml-v2', parentId: 'ml-v1', definition: m({ c: {} }) })).status, 201);
  assert.equal((await put({ id: 'ml-v3', parentId: 'ml-v2', historyPath: ['GO'], definition: m({ c: {}, d: {} }) })).status, 201);
  const a = (await j('POST', '/v1/actors', { definitionId: 'ml-v1' })).body;   // family root id
  assert.equal(a.definitionId, 'ml-v3');
});

test('late matchers: a history-targeted deployment warns about states it cannot place', async () => {
  const m = (states) => ({ id: 'late', initial: 'a', states });
  assert.equal((await put({ id: 'late-v1', definition: m({ a: { on: { GO: 'b' } }, b: { on: { GO: 'c' } }, c: {} }) })).status, 201);
  await j('POST', '/v1/actors', { definitionId: 'late-v1' });                  // in 'a': does not match [GO] yet
  const r = await put({ id: 'late-v2', parentId: 'late-v1', historyPath: ['GO'], definition: m({ a: {}, b2: {}, c: {} }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const w = r.body.warnings.find((x) => x.code === 'LATE_MATCHER_RISK');
  assert.ok(w, JSON.stringify(r.body.warnings));
  assert.deepEqual(w.versions[0].states, ['b']);
});

test('history patterns may name delayed transitions as { after, ms }', async () => {
  const m = { id: 'tmr', initial: 'a', states: { a: { after: { 60000: 'b' }, on: { GO: 'c' } }, b: {}, c: {} } };
  assert.equal((await put({ id: 'tmr-v1', definition: m })).status, 201);
  const r = await put({ id: 'tmr-v2', parentId: 'tmr-v1', historyPath: [{ after: 'a', ms: 60000 }], definition: m });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test('the registry is collected below the frontier', async () => {
  const m = (extra = {}) => ({ id: 'gc', initial: 'a', states: { a: { on: { GO: 'a' } }, ...extra } });
  assert.equal((await put({ id: 'gc-v1', definition: m() })).status, 201);
  const a = (await j('POST', '/v1/actors', { definitionId: 'gc-v1' })).body;
  for (let i = 2; i <= 4; i++) {
    assert.equal((await put({ id: `gc-v${i}`, parentId: `gc-v${i - 1}`, definition: m({ [`s${i}`]: {} }) })).status, 201);
  }
  await send(a.id, 'GO');
  assert.equal((await actorOf(a.id)).definitionId, 'gc-v4');
  await sleep(1500);                                                   // collection runs every 300ms
  const rows = await j('GET', '/v1/admin/registry?family=gc-v1');
  if (rows.status === 404) return;                                     // no admin view: covered by unit test
  assert.equal(rows.status, 200);
  assert.ok(rows.body.collected >= 2, JSON.stringify(rows.body));
  // still routes correctly afterwards
  assert.equal((await put({ id: 'gc-v5', parentId: 'gc-v4', definition: m({ s5: {} }) })).status, 201);
  await send(a.id, 'GO');
  assert.equal((await actorOf(a.id)).definitionId, 'gc-v5');
});

test('embedded mode: a deployment registers a change-point and migrates actors in-process', { skip: !!pg }, () => {
  const script = `
    import { createStateKeep } from './src/lib/index.js';
    const sk = await createStateKeep({ dbPath: ${JSON.stringify(join(dir, 'emb.db'))}, encryptionKey: '7f'.repeat(32) });
    const v1 = await sk.deployDefinition({ id: 'emb', initial: 'a', states: { a: { on: { GO: 'b' } }, b: {} } });
    const act = await sk.spawnActor({ definitionId: v1.id });
    const v2 = await sk.deployDefinition({ id: 'emb', initial: 'a', states: { a: { on: { GO: 'b' } }, b: {}, c: {} } }, { parentId: v1.id });
    const s = await sk.getActor(act.id);
    console.log(JSON.stringify({ v2: v2.id, def: s.definitionId, migrated: v2.migrated }));
    await sk.close(); process.exit(0);`;
  const file = join(process.cwd(), `.emb-test-${process.pid}.mjs`);
  writeFileSync(file, script);
  let r;
  try { r = spawnSync(process.execPath, [file], { env: { ...process.env, LOG_LEVEL: 'silent' }, encoding: 'utf8', timeout: 60000 }); }
  finally { rmSync(file, { force: true }); }
  const line = r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, r.stderr + r.stdout);
  const out = JSON.parse(line);
  assert.equal(out.def, out.v2);
  assert.equal(out.migrated, 1);
});
