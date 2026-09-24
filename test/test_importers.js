/**
 * test/test_importers.js — import Step Functions / SCXML / BPMN, deploy, and run real
 * paths through the imported workflows. Starts its own server.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importDefinition } from '../src/importers/index.js';
import { compileCondition } from '../src/runtime/conditionGuards.js';

const PORT = 3093, BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'sk-imp-'));
const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'test', HOST: '127.0.0.1',
  STATEKEEP_DB_PATH: join(dir, 'i.db'), STATEKEEP_ENCRYPTION_KEY: 'ef'.repeat(32),
  LOG_DIR: join(dir, 'logs'), STATEKEEP_DATA_DIR: join(dir, 'data') };
delete env.STATEKEEP_API_KEY; delete env.STATEKEEP_REMOTE_URL; delete env.STATEKEEP_DB_URL;
let server;

const j = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sample = (f) => readFileSync(join('examples/imports', f), 'utf8');
async function deployFrom(file, defId) {
  const imp = await j('POST', '/v1/definitions/import', { source: sample(file) });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.valid, true, JSON.stringify(imp.body.errors));
  const d = await j('PUT', '/v1/definitions', { id: defId, definition: imp.body.definition });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  return imp.body;
}
const spawnActor = async (defId, ctx) => (await j('POST', '/v1/actors', { definitionId: defId, initialContext: ctx })).body;
const ev = async (id, type, payload) => (await j('POST', `/v1/actors/${id}/event`, { type, payload })).body;

before(async () => {
  server = spawn(process.execPath, ['src/api/server.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/v1/health`)).ok) break; } catch {} await new Promise((r) => { setTimeout(r, 250); }); }
});
after(() => { server?.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });

test('cond: expressions — evaluation and safety', () => {
  const g = compileCondition('score >= 700 && amount < 1000000');
  assert.equal(g({ context: { score: 720, amount: 5 } }), true);
  assert.equal(g({ context: { score: 650, amount: 5 } }), false);
  assert.equal(compileCondition('missing == null')({ context: {} }), true);
  assert.throws(() => compileCondition('__proto__.x == 1'));
  assert.throws(() => compileCondition('process.exit()'));
});

test('Step Functions: Choice rules become cond: guards and route correctly', async () => {
  await deployFrom('loan.asl.json', 'asl-loan-v1');
  // Choice is evaluated right after checkCredit reports DONE (with the score in the payload)
  const good = await spawnActor('asl-loan-v1', { amount: 50000 });
  assert.equal((await ev(good.id, 'DONE', { score: 720 })).stateValue, 'Approved');
  const low = await spawnActor('asl-loan-v1', { amount: 50000 });
  assert.equal((await ev(low.id, 'DONE', { score: 420 })).stateValue, 'Rejected');
  const mid = await spawnActor('asl-loan-v1', { amount: 50000 });
  assert.equal((await ev(mid.id, 'DONE', { score: 600 })).stateValue, 'Manual_Review');
  const err = await spawnActor('asl-loan-v1', { amount: 50000 });
  assert.equal((await ev(err.id, 'FAILED')).stateValue, 'Manual_Review', 'Catch → Manual Review');
});

test('SCXML: nested states, conditions and global targets', async () => {
  await deployFrom('order.scxml', 'scxml-order-v1');
  const empty = await spawnActor('scxml-order-v1', { total: 0 });
  assert.equal((await ev(empty.id, 'CHECKOUT')).stateValue, 'cart', 'cond total > 0 blocks an empty cart');
  const o = await spawnActor('scxml-order-v1', { total: 120 });
  assert.deepEqual((await ev(o.id, 'CHECKOUT')).stateValue, { payment: 'authorizing' });
  assert.deepEqual((await ev(o.id, 'AUTHORIZED')).stateValue, { payment: 'capturing' });
  assert.equal((await ev(o.id, 'CAPTURED')).stateValue, 'shipping');
  const done = await ev(o.id, 'DELIVERED');
  assert.equal(done.stateValue, 'done');
  assert.equal(done.done, true);
  const c = await spawnActor('scxml-order-v1', { total: 5 });
  await ev(c.id, 'CHECKOUT');
  assert.equal((await ev(c.id, 'CANCEL')).stateValue, 'cancelled', 'parent-level CANCEL applies from a child state');
});

test('BPMN: service tasks, exclusive gateway with default flow, message catch', async () => {
  await deployFrom('claim.bpmn', 'bpmn-claim-v1');
  const small = await spawnActor('bpmn-claim-v1', { amount: 400 });
  assert.equal((await ev(small.id, 'DONE')).stateValue, 'Pay', 'amount <= 1000 → auto pay');
  const big = await spawnActor('bpmn-claim-v1', { amount: 9000 });
  assert.equal((await ev(big.id, 'DONE')).stateValue, 'WaitDocs', 'default flow');
  assert.equal((await ev(big.id, 'DOCUMENTS_RECEIVED')).stateValue, 'Adjuster');
  assert.equal((await ev(big.id, 'DONE')).stateValue, 'Pay');
  assert.equal((await ev(big.id, 'DONE')).stateValue, 'End');
});

test('unsupported constructs are reported, not silently dropped', () => {
  const { warnings } = importDefinition('asl', {
    StartAt: 'A', States: {
      A: { Type: 'Choice', Choices: [{ Variable: '$.name', StringMatches: 'x*', Next: 'B' }] },
      B: { Type: 'Map', Next: 'C' }, C: { Type: 'Succeed' },
    },
  });
  const types = warnings.map((w) => w.type);
  assert.ok(types.includes('UNSUPPORTED_CONDITION'));
  assert.ok(types.includes('NO_DEFAULT'));
  assert.ok(types.includes('SIMPLIFIED'));
});

test('malformed cond: guard is rejected at deploy', async () => {
  const r = await j('PUT', '/v1/definitions', { id: 'badcond-v1', definition: { id: 'bc', initial: 'a', states: { a: { always: [{ target: 'b', guard: 'cond:amount <' }] }, b: {} } } });
  assert.equal(r.status, 422);
});
