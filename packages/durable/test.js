/**
 * @statekeep/durable against a real StateKeep server (SQLite, spawned here).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { crashy } from './fixtures/crashy.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine, replayCheck } from './index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 3098, URL_ = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'sk-durable-'));
let server;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Side effects the workflows perform (to prove steps are not repeated on replay)
const effects = [];
const did = (what, input) => { effects.push(`${what}:${input.email}`); return `${what}-ok`; };
const count = (what, email) => effects.filter((e) => e === `${what}:${email}`).length;

const onboarding = {
  v1: async (ctx, input) => {
    const acct = await ctx.step('createAccount', () => { did('create', input); return { id: `acct-${input.email}` }; });
    await ctx.waitForEvent('EMAIL_VERIFIED');
    await ctx.step('sendWelcome', () => did('welcome', input));
    const login = await ctx.waitForEvent('FIRST_LOGIN');
    return { accountId: acct.id, loggedInFrom: login?.device ?? null, version: 'v1' };
  },
  // v2: new regulation — a KYC check right after the account is created
  v2: async (ctx, input) => {
    const acct = await ctx.step('createAccount', () => ({ id: `acct-${input.email}` }));
    await ctx.step('kycCheck', () => did('kyc', input));
    await ctx.waitForEvent('EMAIL_VERIFIED');
    await ctx.step('sendWelcome', () => did('welcome', input));
    const login = await ctx.waitForEvent('FIRST_LOGIN');
    return { accountId: acct.id, loggedInFrom: login?.device ?? null, version: 'v2' };
  },
  // v3: 'sendWelcome' renamed and a reminder timer added before waiting for the first login
  v3: async (ctx, input) => {
    const acct = await ctx.step('createAccount', () => ({ id: `acct-${input.email}` }));
    await ctx.step('kycCheck', () => did('kyc', input));
    await ctx.waitForEvent('EMAIL_VERIFIED');
    await ctx.step('sendWelcomeEmail', () => did('welcome', input));
    await ctx.sleep(300);
    await ctx.step('sendLoginReminder', () => did('reminder', input));
    const login = await ctx.waitForEvent('FIRST_LOGIN');
    return { accountId: acct.id, loggedInFrom: login?.device ?? null, version: 'v3' };
  },
};
const engineWith = (versions, releases = []) =>
  createEngine({ url: URL_, workflows: { onboarding: Object.fromEntries(versions.map((v) => [v, onboarding[v]])) }, releases });

before(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'test',
    STATEKEEP_DB_PATH: join(dir, 'd.db'), STATEKEEP_ENCRYPTION_KEY: '9a'.repeat(32),
    LOG_DIR: join(dir, 'logs'), STATEKEEP_DATA_DIR: join(dir, 'data') };
  delete env.STATEKEEP_API_KEY; delete env.STATEKEEP_DB_URL; delete env.STATEKEEP_REMOTE_URL;
  server = spawn(process.execPath, ['src/api/server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${URL_}/v1/health`)).ok) break; } catch {} await sleep(250); }
  await engineWith(['v1']).setup();
  await engineWith(['v1']).setup();           // idempotent
});
after(() => { server?.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });

test('steps run once, waits are durable, a fresh engine resumes from the journal', async () => {
  const e1 = engineWith(['v1']);
  const id = await e1.start('onboarding', { email: 'amna' });
  assert.deepEqual((await e1.get(id)), { runId: id, status: 'waiting', version: 'v1', output: null, error: null, steps: ['step:createAccount'], waitingFor: 'EMAIL_VERIFIED' });

  const e2 = engineWith(['v1']);                // "after a restart": no memory of the run
  await e2.signal(id, 'EMAIL_VERIFIED');
  const r = await e2.signal(id, 'FIRST_LOGIN', { device: 'phone' });
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.output, { accountId: 'acct-amna', loggedInFrom: 'phone', version: 'v1' });
  assert.equal(count('create', 'amna'), 1, 'createAccount replayed, not re-run');
  assert.equal(count('welcome', 'amna'), 1);

  const events = (await (await fetch(`${URL_}/v1/actors/${id}/events?limit=50`)).json()).events.map((e) => e.eventType ?? e.type);
  assert.ok(events.filter((t) => t === 'STEP').length === 4, `audit trail: ${events}`);
});

test('a signal that arrives before the workflow waits for it is kept', async () => {
  const e = engineWith(['v1']);
  const id = await e.start('onboarding', { email: 'early' }, { wait: true });
  await e.signal(id, 'EMAIL_VERIFIED');
  // FIRST_LOGIN delivered while the run is past EMAIL_VERIFIED but before it asks for FIRST_LOGIN is fine too
  const r = await e.signal(id, 'FIRST_LOGIN', { device: 'web' });
  assert.equal(r.status, 'completed');
});

test('preview + release: compatible runs move to v2, incompatible ones finish on v1', async () => {
  const e1 = engineWith(['v1']);
  const waitingEmail = await e1.start('onboarding', { email: 'bilal' });     // journal: createAccount
  const waitingLogin = await e1.start('onboarding', { email: 'hina' });
  await e1.signal(waitingLogin, 'EMAIL_VERIFIED');                          // journal: createAccount, signal, sendWelcome

  const release = { workflow: 'onboarding', from: 'v1', to: 'v2' };
  const e2 = engineWith(['v1', 'v2'], [release]);
  const plan = await e2.preview(release);
  assert.ok(plan.moves.some((m) => m.runId === waitingEmail));
  const inc = plan.incompatible.find((m) => m.runId === waitingLogin);
  assert.match(inc.reason, /expects step "kycCheck" at #1, but the run recorded signal "EMAIL_VERIFIED"/);

  await e2.resumeAll();
  assert.equal((await e2.get(waitingEmail)).version, 'v2', 'moved at its checkpoint');
  assert.equal(count('kyc', 'bilal'), 1, 'the new KYC step ran for the moved run');
  assert.equal((await e2.get(waitingLogin)).version, 'v1', 'not moved: its history is incompatible');

  await e2.signal(waitingEmail, 'EMAIL_VERIFIED');
  assert.equal((await e2.signal(waitingEmail, 'FIRST_LOGIN')).output.version, 'v2');
  assert.equal((await e2.signal(waitingLogin, 'FIRST_LOGIN')).output.version, 'v1', 'old runs finish on the old code');
  assert.equal(count('create', 'bilal'), 1);
  assert.equal(count('kyc', 'hina'), 0, 'no KYC retroactively for a run already past that point');

  const fresh = await e2.start('onboarding', { email: 'nadia' });
  assert.equal((await e2.get(fresh)).version, 'v2', 'new runs start on the newest version');
});

test('`when` targets one history; renameSteps crosses a rename; durable timer', async () => {
  const e2 = engineWith(['v2']);
  const atEmail = await e2.start('onboarding', { email: 'sana' });          // createAccount, kycCheck
  const atLogin = await e2.start('onboarding', { email: 'omar' });
  await e2.signal(atLogin, 'EMAIL_VERIFIED');                              // …, signal, sendWelcome

  const onlyEarly = { workflow: 'onboarding', from: 'v2', to: 'v3', when: ['createAccount', 'kycCheck'], renameSteps: { sendWelcome: 'sendWelcomeEmail' } };
  const e3 = engineWith(['v2', 'v3'], [onlyEarly]);
  const plan = await e3.preview(onlyEarly);
  assert.ok(plan.moves.some((m) => m.runId === atEmail), 'same history as `when`: moves');
  assert.ok(!plan.moves.some((m) => m.runId === atLogin));
  assert.ok(plan.stays.some((m) => m.runId === atLogin), 'different history: not targeted');

  await e3.resumeAll();
  assert.equal((await e3.get(atEmail)).version, 'v3');
  assert.equal((await e3.get(atLogin)).version, 'v2');

  // Now a release for everyone else, crossing the step rename
  const all = { workflow: 'onboarding', from: 'v2', to: 'v3', renameSteps: { sendWelcome: 'sendWelcomeEmail' } };
  const e3b = engineWith(['v2', 'v3'], [all]);
  assert.deepEqual((await e3b.preview(all)).incompatible.filter((m) => m.runId === atLogin), []);
  await e3b.resumeAll();
  const moved = await e3b.get(atLogin);
  assert.equal(moved.version, 'v3');
  assert.ok(moved.steps.includes('step:sendWelcomeEmail'), 'journal entry renamed');
  assert.equal(moved.waitingFor, '__timer', 'v3 adds a reminder timer');
  assert.equal(count('reminder', 'omar'), 0);
  await sleep(400);
  await e3b.resumeAll();                                                   // timer due
  assert.equal(count('reminder', 'omar'), 1);
  assert.equal((await e3b.signal(atLogin, 'FIRST_LOGIN')).output.version, 'v3');
  assert.equal(count('welcome', 'omar'), 1, 'welcome not re-sent after the rename');
});

test('two engines racing on one run record each step once', async () => {
  const a = engineWith(['v1']), b = engineWith(['v1']);
  const id = await a.start('onboarding', { email: 'race' });
  await fetch(`${URL_}/v1/actors/${id}/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'SIGNAL', payload: { inbox_EMAIL_VERIFIED: { payload: null } } }) });
  await Promise.all([a.resume(id), b.resume(id)]);
  const run = await a.get(id);
  assert.deepEqual(run.steps, ['step:createAccount', 'signal:EMAIL_VERIFIED', 'step:sendWelcome']);
});

test('the process dies mid-step: another process resumes; completed steps are not repeated', async () => {
  const log = join(dir, 'crashy.log');
  const child = spawnSync(process.execPath, [join(ROOT, 'packages/durable/fixtures/crashy.mjs'), URL_, log], { env: { ...process.env, CRASH_IN_B: '1' } });
  assert.equal(child.status, 9, 'the worker process crashed');
  assert.equal(readFileSync(log, 'utf8'), 'a\n');
  const engine = createEngine({ url: URL_, workflows: { crashy } });
  const results = await engine.resumeAll();
  assert.ok(results.some((r) => r.status === 'completed' && r.output === 'finished'));
  assert.equal(readFileSync(log, 'utf8'), 'a\nb\n', 'a ran once, b ran after the restart');
});

test('replayCheck explains non-determinism', async () => {
  const j = [{ kind: 'step', name: 'a', result: 1 }, { kind: 'step', name: 'b', result: 2 }];
  assert.deepEqual(await replayCheck(async (ctx) => { await ctx.step('a'); await ctx.step('b'); await ctx.step('c'); }, {}, j), { ok: true });
  assert.match((await replayCheck(async (ctx) => { await ctx.step('a'); await ctx.step('x'); }, {}, j)).reason, /expects step "x" at #1/);
  assert.match((await replayCheck(async (ctx) => { await ctx.step('a'); }, {}, j)).reason, /finishes after 1 steps/);
});
