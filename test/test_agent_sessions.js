/**
 * test/test_agent_sessions.js — an AI agent session as a StateKeep actor
 * (examples/agent). The model and tools run in a Python service; StateKeep holds
 * the session durably: tool calls, a human approval step, crash recovery, and
 * moving live sessions to a new prompt + approval policy.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedPostgres } from './helpers/isolatedDb.js';

const PY_PORT = 8099, PORT = 3097, BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'agent-test-secret';
const dir = mkdtempSync(join(tmpdir(), 'sk-agent-'));
const LOG = join(dir, 'side-effects.jsonl');
const def = (v) => JSON.parse(readFileSync(`examples/agent/support-agent.${v}.json`, 'utf8'));
let py, server, migrator;

const env = {
  ...process.env, PORT: String(PORT), NODE_ENV: 'test', HOST: '127.0.0.1',
  STATEKEEP_DB_PATH: join(dir, 'a.db'), STATEKEEP_ENCRYPTION_KEY: 'ef'.repeat(32),
  STATEKEEP_ADMIN_KEY: 'agent-admin-key-1234567890',
  STATEKEEP_REMOTE_URL: `http://127.0.0.1:${PY_PORT}/statekeep`, STATEKEEP_REMOTE_SECRET: SECRET,
  STATEKEEP_ACTION_LEASE_MS: '1500',
  LOG_DIR: join(dir, 'logs'), STATEKEEP_DATA_DIR: join(dir, 'data'),
};
delete env.STATEKEEP_API_KEY;

const j = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const waitFor = async (fn, ms = 15_000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; };
const get = async (id) => (await j('GET', `/v1/actors/${id}`)).body;
const until = async (id, pred, label) => {
  const a = await waitFor(async () => { const x = await get(id); return pred(x) ? x : null; });
  assert.ok(a, `timed out waiting for ${label}; now ${JSON.stringify(await get(id))}`);
  return a;
};
const say = (id, message) => j('POST', `/v1/actors/${id}/event`, { type: 'USER_MESSAGE', payload: { message } });
const refunds = (id) => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
  .filter((e) => e.kind === 'refund' && e.actorId === id);

async function startServer() {
  server = spawn(process.execPath, ['src/api/server.js'], { env, stdio: 'ignore' });
  assert.ok(await waitFor(async () => { try { return (await fetch(`${BASE}/v1/health`)).ok; } catch { return false; } }), 'server up');
}
const newSession = async (definitionId = 'support-agent-v1') => (await j('POST', '/v1/actors', { definitionId })).body.id;

before(async () => {
  const pgUrl = await isolatedPostgres('agent');   // own database: no other server may take our jobs
  if (pgUrl) env.STATEKEEP_DB_URL = pgUrl;
  py = spawn('python3', ['examples/agent/agent_service.py'], { env: { ...process.env, PORT: String(PY_PORT), STATEKEEP_REMOTE_SECRET: SECRET, AGENT_LOG: LOG, AGENT_SLOW_ORDER: '31337' }, stdio: 'ignore' });
  await sleep(500);
  await startServer();
  migrator = spawn(process.execPath, ['src/workers/migrate-worker.js'], { env, stdio: 'ignore' });
  const r = await j('PUT', '/v1/definitions', { id: 'support-agent-v1', definition: def('v1') });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});
after(() => { for (const p of [server, migrator, py]) p?.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });

test('tool call pauses for human approval, then runs exactly once', async () => {
  const id = await newSession();
  await say(id, 'Please refund $80 on order #1234');
  const parked = await until(id, (a) => a.stateValue === 'awaiting_approval', 'approval step');
  assert.deepEqual(parked.context.args, { orderId: '1234', amount: 80 });
  assert.equal(refunds(id).length, 0, 'nothing happens before a human approves');

  assert.equal((await j('POST', `/v1/actors/${id}/event`, { type: 'APPROVE' })).status, 200);
  const done = await until(id, (a) => a.stateValue === 'idle', 'reply');
  assert.equal(done.context.lastReply, 'Done: refunded $80 on order 1234');
  assert.equal(refunds(id).length, 1);
  assert.deepEqual(done.context.transcript.map((m) => m.role), ['user', 'assistant', 'assistant']);
});

test('a lookup tool runs without approval', async () => {
  const id = await newSession();
  await say(id, 'Where is order #777?');
  const done = await until(id, (a) => a.stateValue === 'idle' && a.context.lastReply, 'reply');
  assert.equal(done.context.lastReply, 'Done: order 777 is in transit');
});

test('denied: no refund, the model explains', async () => {
  const id = await newSession();
  await say(id, 'refund $300 on order #42');
  await until(id, (a) => a.stateValue === 'awaiting_approval', 'approval step');
  await j('POST', `/v1/actors/${id}/event`, { type: 'DENY', payload: { reason: 'duplicate request' } });
  const done = await until(id, (a) => a.stateValue === 'idle', 'reply');
  assert.match(done.context.lastReply, /not approved \(duplicate request\)/);
  assert.equal(refunds(id).length, 0);
});

test('a session waiting for approval survives a server crash', async () => {
  const id = await newSession();
  await say(id, 'refund $120 on order #9001');
  await until(id, (a) => a.stateValue === 'awaiting_approval', 'approval step');
  server.kill('SIGKILL');
  await sleep(300);
  await startServer();
  assert.equal((await get(id)).stateValue, 'awaiting_approval', 'still waiting after the crash');
  assert.equal((await j('POST', `/v1/actors/${id}/event`, { type: 'APPROVE' })).status, 200);
  const done = await until(id, (a) => a.stateValue === 'idle', 'reply');
  assert.equal(done.context.lastReply, 'Done: refunded $120 on order 9001');
  assert.equal(refunds(id).length, 1);
});

test('server killed while a tool call is running: the tool call is picked up again', async () => {
  const id = await newSession();
  await say(id, 'where is order #31337');                    // this tool takes 2s
  const toolCalls = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse) : [])
    .filter((e) => e.kind === 'tool_call' && e.actorId === id);
  assert.ok(await waitFor(async () => toolCalls().length === 1), 'the tool call has started');
  server.kill('SIGKILL');                                   // dies while holding the job
  await sleep(300);
  await startServer();
  const done = await until(id, (a) => a.stateValue === 'idle' && a.context.lastReply, 'reply after restart');
  assert.equal(done.context.lastReply, 'Done: order 31337 is in transit');
  const calls = toolCalls();
  // The job was re-claimed after its lease ran out and sent again with the same jobId;
  // the SDK answered the retry from its jobId cache when the first call had finished.
  assert.ok(calls.every((c) => c.jobId === calls[0].jobId), 'retries carry the same jobId');
});

test('live sessions move to a new prompt + approval policy without losing their place', async () => {
  const parked = await newSession();                       // waiting for approval under v1
  await say(parked, 'refund $80 on order #5000');
  await until(parked, (a) => a.stateValue === 'awaiting_approval', 'approval step');
  const chatting = await newSession();                     // mid-conversation under v1
  await say(chatting, 'hello');
  await until(chatting, (a) => a.stateValue === 'idle' && a.context.lastReply, 'first reply');

  // v2: new prompt (callModelV2), the approval state is renamed, and refunds under $50 no longer need approval
  const r = await j('PUT', '/v1/definitions', {
    id: 'support-agent-v2', parentId: 'support-agent-v1', definition: def('v2'),
    stateMapping: { awaiting_approval: 'pending_approval' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const moved = await until(parked, (a) => a.definitionId === 'support-agent-v2', 'migration of the parked session');
  assert.equal(moved.stateValue, 'pending_approval', 'the pending approval is kept (renamed state)');

  await j('POST', `/v1/actors/${parked}/event`, { type: 'APPROVE' });
  const p = await until(parked, (a) => a.stateValue === 'idle', 'reply after approval');
  assert.equal(p.context.lastReply, '[v2] Done: refunded $80 on order 5000', 'the new prompt answers');
  assert.equal(refunds(parked).length, 1);

  await until(chatting, (a) => a.definitionId === 'support-agent-v2', 'migration of the idle session');
  await say(chatting, 'where is order #555');
  const c = await until(chatting, (a) => a.stateValue === 'idle' && a.context.lastReply?.startsWith('[v2]'), 'v2 reply');
  assert.equal(c.context.lastReply, '[v2] Done: order 555 is in transit');
  assert.equal(c.context.transcript[0].text, 'hello', 'conversation history carried over');

  const fresh = await newSession('support-agent-v2');       // new policy: small refunds are automatic
  await say(fresh, 'refund $20 on order #6006');
  const f = await until(fresh, (a) => a.stateValue === 'idle' && a.context.lastReply, 'auto refund');
  assert.equal(f.context.lastReply, '[v2] Done: refunded $20 on order 6006');
  assert.equal(refunds(fresh).length, 1);
});
