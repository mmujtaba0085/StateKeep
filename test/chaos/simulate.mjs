#!/usr/bin/env node
/**
 * test/chaos/simulate.mjs — probabilistic fault simulation against real processes.
 *
 *   node test/chaos/simulate.mjs --seed 7 --rounds 12 --per-round 30 --backend sqlite
 *   node test/chaos/simulate.mjs --backend postgres --db postgresql://…/empty_db
 *   node test/chaos/simulate.mjs --backend cluster  --db postgresql://…/empty_db
 *
 * Each CASE is one payment actor running one side-effecting action (4 delivery setups)
 * with its own fault profile — one fault per attempt, drawn from FAULTS by probability —
 * and its own client behaviour (duplicate / concurrent requests). Each ROUND also draws
 * GLOBAL faults that hit every case in flight at that moment: kill -9 of an API server,
 * the implementation service crashing or staying down, a live migration to a new
 * version, a storm of concurrent events. Faults overlap freely.
 *
 * After every round a simulated human resolves the review queue from ground truth, and
 * every case is checked against the invariants below. Same seed → same plan.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, openSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SEED = Number(arg('seed', 7)), ROUNDS = Number(arg('rounds', 12)), PER_ROUND = Number(arg('per-round', 30));
const BACKEND = arg('backend', 'sqlite'), DB_URL = arg('db', process.env.STATEKEEP_DB_URL ?? '');
const OUT = arg('out', join(ROOT, `chaos-report-${BACKEND}-seed${SEED}.json`));
if (BACKEND !== 'sqlite' && !DB_URL.startsWith('postgres')) throw new Error('--db postgres://… (empty database) required');

// ── Probabilities ────────────────────────────────────────────────────────────
const FAULTS = [                       // per attempt of the action
  ['ok', 0.45], ['slow', 0.15], ['error_4xx', 0.12], ['late_success', 0.08],
  ['hang_no_effect', 0.07], ['crash_after', 0.07], ['crash_before', 0.06],
];
const GLOBAL = {                       // per round, independent → several can coincide
  server_kill: 0.35, service_crash: 0.25, service_outage: 0.20, migration: 0.15, event_storm: 0.20,
};
const CLIENT = { duplicate_request: 0.25, noise_events: 0.20 };
// --intensity hard: most attempts fail somehow, and global faults hit most rounds
if (arg('intensity', 'normal') === 'hard') {
  FAULTS[0][1] = 0.15;
  for (const k of Object.keys(GLOBAL)) GLOBAL[k] = Math.min(0.9, GLOBAL[k] * 2.2);
}
const ACTIONS = {                      // event → [working state, action, delivery, follow-up]
  CHARGE: ['charging',  'chargeCard',    'idempotent',        'CHARGED'],
  REFUND: ['refunding', 'refundOrder',   'verify (verifier)', 'REFUNDED'],
  NOTIFY: ['notifying', 'notifyPartner', 'verify (SDK store)', 'NOTIFIED'],
  SMS:    ['texting',   'sendSms',       'at-most-once',      'SMS_SENT'],
};

// ── Seeded randomness ────────────────────────────────────────────────────────
let s = SEED >>> 0;
const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pickW = (pairs) => { let r = rnd() * pairs.reduce((a, [, w]) => a + w, 0); for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; } return pairs[0][0]; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const uni = (a, b) => a + rnd() * (b - a);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ── Processes ────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), `sk-chaos-${BACKEND}-`));
const FILES = { requests: join(dir, 'requests.jsonl'), effects: join(dir, 'effects.jsonl'), attempts: join(dir, 'attempts.jsonl'), bank: join(dir, 'bank.jsonl'), store: join(dir, 'jobs.sqlite') };
const PY_PORT = 8190, SECRET = 'chaos-secret', ADMIN = 'chaos-admin-key-1234567890';
const N_SERVERS = BACKEND === 'cluster' ? 2 : 1;
const servers = Array.from({ length: N_SERVERS }, (_, i) => ({ i, port: 3190 + i, proc: null, base: `http://127.0.0.1:${3190 + i}` }));
const baseEnv = {
  ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1',
  STATEKEEP_ENCRYPTION_KEY: '3e'.repeat(32), STATEKEEP_ADMIN_KEY: ADMIN,
  STATEKEEP_REMOTE_URL: `http://127.0.0.1:${PY_PORT}/statekeep`, STATEKEEP_REMOTE_SECRET: SECRET,
  STATEKEEP_REMOTE_TIMEOUT_MS: '1500', STATEKEEP_ACTION_LEASE_MS: '2000', STATEKEEP_ACTION_BACKOFF_MAX_MS: '5000',
  LOG_DIR: join(dir, 'logs'), STATEKEEP_DATA_DIR: join(dir, 'data'),
  ...(BACKEND === 'sqlite' ? { STATEKEEP_DB_PATH: join(dir, 'chaos.db') } : { STATEKEEP_DB_URL: DB_URL }),
  ...(BACKEND === 'cluster' ? { STATEKEEP_CLUSTER: 'true', STATEKEEP_NODE_TTL_MS: '2000' } : {}),
};
delete baseEnv.STATEKEEP_API_KEY;
if (BACKEND === 'sqlite') delete baseEnv.STATEKEEP_DB_URL;

const alive = async (base) => { try { return (await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } };
async function startServer(sv) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const log = openSync(join(dir, 'out', `server${sv.i}.log`), 'a');
  sv.proc = spawn(process.execPath, ['src/api/server.js'], { cwd: ROOT, stdio: ['ignore', log, log],
    env: { ...baseEnv, PORT: String(sv.port), STATEKEEP_NODE_ID: `node${sv.i}`, STATEKEEP_NODE_URL: sv.base } });
  for (let k = 0; k < 120 && !(await alive(sv.base)); k++) await sleep(100);
  if (sv.proc.exitCode !== null) throw new Error(`server ${sv.i} exited at startup (${sv.proc.exitCode})`);
}
let py = null, serviceHeldDown = 0;
function startService() {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const plog = openSync(join(dir, 'out', 'service.log'), 'a');
  py = spawn('python3', ['test/chaos/chaos_service.py'], { cwd: ROOT, stdio: ['ignore', plog, plog],
    env: { ...process.env, PORT: String(PY_PORT), STATEKEEP_REMOTE_SECRET: SECRET, JOB_STORE: FILES.store,
      EFFECTS_FILE: FILES.effects, ATTEMPTS_FILE: FILES.attempts, REQUESTS_FILE: FILES.requests, BANK_FILE: FILES.bank } });
  const me = py;
  py.on('exit', () => {                                     // supervisor: crashed services come back
    if (me !== py) return;
    counters.serviceExits++;
    if (serviceHeldDown === Infinity) return;              // shutting down
    setTimeout(() => { if (me === py) startService(); }, Math.max(uni(200, 1200), serviceHeldDown - Date.now()));
  });
}
const counters = { serviceExits: 0, serverKills: 0, migrations: 0, reviews: 0, clientRetries: 0 };
const migrator = () => spawn(process.execPath, ['src/workers/migrate-worker.js'], { cwd: ROOT, stdio: 'ignore',
  env: { ...baseEnv, PORT: String(servers[0].port), STATEKEEP_INTERNAL_URL: servers[0].base } });

// ── HTTP with client-side retries (what a real client does) ─────────────────
const liveServer = () => pick(servers.filter((x) => x.proc && x.proc.exitCode === null && x.proc.signalCode === null)) ?? servers[0];
async function api(method, path, body, { retry = true, deadline = 90_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const sv = liveServer();
    try {
      const r = await fetch(sv.base + path, { method, headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
      const data = await r.json().catch(() => ({}));
      if (r.status < 500 && r.status !== 429) return { status: r.status, body: data };
      if (!retry) return { status: r.status, body: data };
    } catch (err) { if (!retry) return { status: 0, body: { error: err.message } }; }
    if (Date.now() - t0 > deadline) return { status: 0, body: { error: 'client gave up' } };
    counters.clientRetries++;
    await sleep(uni(100, 400));
  }
}

// ── Definition (one per version; migrations add an unused state) ────────────
function definition(v) {
  const states = { idle: { on: Object.fromEntries(Object.entries(ACTIONS).map(([ev, [st]]) => [ev, st])) }, done: {}, failed: {}, needs_review: { on: {} } };
  for (const [, [st, action, , follow]] of Object.entries(ACTIONS)) {
    states[st] = { entry: [action], on: { [follow]: 'done', [`__SK_ACTION_UNKNOWN.${action}`]: 'needs_review', [`__SK_ACTION_FAILED.${action}`]: 'failed' } };
    states.needs_review.on[follow] = 'done';
    states.needs_review.on[`__SK_ACTION_FAILED.${action}`] = 'failed';     // a re-run that then failed for sure
  }
  for (let k = 2; k <= v; k++) states[`unused_v${k}`] = {};
  return { id: 'chaos-payment', initial: 'idle', states };
}
let version = 1;
async function deployNext() {
  const r = await api('PUT', '/v1/definitions', { id: `chaos-v${version + 1}`, parentId: `chaos-v${version}`, definition: definition(version + 1) });
  if (r.status === 201 || r.status === 200) { version++; counters.migrations++; }
}

// ── Ground truth ─────────────────────────────────────────────────────────────
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const allEffects = () => [...lines(FILES.effects), ...lines(FILES.bank)];
const effectsOf = (actorId) => allEffects().filter((e) => e.actorId === actorId);
const TERMINAL = new Set(['done', 'failed', 'needs_review']);

// ── One round ────────────────────────────────────────────────────────────────
async function round(r) {
  const plan = Object.fromEntries(Object.entries(GLOBAL).map(([k, p]) => [k, rnd() < p ? uni(0, 5000) : null]));
  const cases = Array.from({ length: PER_ROUND }, (_, i) => {
    const event = pick(Object.keys(ACTIONS));
    return { round: r, idx: i, event, action: ACTIONS[event][1], delivery: ACTIONS[event][2],
      faults: [pickW(FAULTS), pickW(FAULTS), pickW(FAULTS)],
      duplicate: rnd() < CLIENT.duplicate_request, noise: rnd() < CLIENT.noise_events, startDelay: uni(0, 4000) };
  });
  const globalFired = [];
  const chaos = Object.entries(plan).filter(([, at]) => at != null).map(async ([kind, at]) => {
    await sleep(at);
    globalFired.push(kind);
    if (kind === 'server_kill') {
      const sv = pick(servers); counters.serverKills++;
      sv.proc?.kill('SIGKILL'); await sleep(uni(300, 2000)); await startServer(sv);
    } else if (kind === 'service_crash') {
      py?.kill('SIGKILL');                                   // supervisor restarts it
    } else if (kind === 'service_outage') {
      serviceHeldDown = Date.now() + uni(2000, 6000); py?.kill('SIGKILL');
    } else if (kind === 'migration') {
      await deployNext();
    } else if (kind === 'event_storm') {
      await Promise.all(cases.filter((c) => c.id).slice(0, 15).map((c) => api('POST', `/v1/actors/${c.id}/event`, { type: 'PING' }, { retry: false })));
    }
  });
  await Promise.all(cases.map(async (c) => {
    await sleep(c.startDelay);
    const sp = await api('POST', '/v1/actors', { definitionId: `chaos-v${version}`, initialContext: { faults: c.faults } });
    c.id = sp.body.id;
    if (!c.id) { c.spawnError = sp.body; return; }
    const send = () => api('POST', `/v1/actors/${c.id}/event`, { type: c.event, idempotencyKey: `trigger-${c.id}` });
    const sends = [send()];
    if (c.duplicate) sends.push(send());
    if (c.noise) sends.push(api('POST', `/v1/actors/${c.id}/event`, { type: 'PING' }, { retry: false }));
    const res = await Promise.all(sends);
    c.confirmed = res[0].status === 200;
    c.triggerStatus = res[0].status;
  }));
  await Promise.all(chaos);

  // settle, then a human resolves the review queue from ground truth
  const state = async (c) => (await api('GET', `/v1/actors/${c.id}`)).body;
  const settle = async (ms, terminal = TERMINAL) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const pending = [];
      for (const c of cases.filter((x) => x.id)) { const a = await state(c); c.final = a.stateValue; c.version = a.definitionId; if (!terminal.has(a.stateValue)) pending.push(c); }
      if (pending.length === 0) return;
      await sleep(500);
    }
  };
  await settle(120_000);
  // A human works the review queue until it is empty (a case can come back: e.g. the
  // re-run after "did not happen" goes unanswered again).
  const mine = new Map(cases.filter((c) => c.id).map((c) => [c.id, c]));
  // (Under heavy collateral crashes an approved re-run can itself go unanswered, so
  // the reviewer keeps going — every decision is based on ground truth at that moment.)
  for (let pass = 0; pass < 15; pass++) {
    const review = ((await api('GET', '/v1/action-jobs?outcome=unknown&limit=500')).body.jobs ?? []).filter((j) => mine.has(j.actorId));
    if (review.length === 0) break;
    await sleep(3000);                          // the reviewer looks things up: late effects land meanwhile
    for (const job of review) {
      const c = mine.get(job.actorId);
      const happened = allEffects().some((e) => e.job === job.id);
      (c.reviewed ??= []).push(happened ? 'happened' : 'did-not-happen');
      counters.reviews++;
      await api('POST', `/v1/action-jobs/${job.id}/resolve`, happened
        ? { happened: true, event: { type: ACTIONS[c.event][3] } } : { happened: false });
    }
    // after a decision the case must leave review (re-run → done/failed/review again)
    const openJobs = async () => new Set(((await api('GET', '/v1/action-jobs?outcome=unknown&limit=500')).body.jobs ?? []).map((j) => j.actorId));
    const t1 = Date.now();
    while (Date.now() - t1 < 90_000) {
      const open = await openJobs();
      let waiting = 0;
      for (const c of cases.filter((x) => x.id)) {
        const a = await state(c); c.final = a.stateValue; c.version = a.definitionId;
        if (!TERMINAL.has(a.stateValue) || (a.stateValue === 'needs_review' && !open.has(c.id))) waiting++;
      }
      if (waiting === 0) break;
      await sleep(500);
    }
  }

  // ── invariants ─────────────────────────────────────────────────────────────
  for (const c of cases) {
    c.violations = [];
    if (!c.id) { c.violations.push(`spawn failed: ${JSON.stringify(c.spawnError)}`); continue; }
    const eff = effectsOf(c.id);
    c.effects = eff.length;
    c.requests = lines(FILES.requests).filter((q) => q.actorId === c.id)
      .map((q) => (q.arrived ? `→ ${q.arrived.split('/').slice(3).join('/')}` : `← ${q.status}`) + (q.rerunApproved ? ' (rerun)' : ''));
    c.attempts = lines(FILES.attempts).filter((a) => a.actorId === c.id).map((a) => `${a.n}:${a.fault}`);
    const h = await api('GET', `/v1/actors/${c.id}/events?limit=200`);
    if (h.status !== 200 || !Array.isArray(h.body.events)) { c.violations.push(`history unavailable: ${h.status}`); continue; }
    const events = h.body.events.map((e) => e.eventType ?? e.type);
    const follow = ACTIONS[c.event][3];
    c.followups = events.filter((t) => t === follow).length;
    if (eff.length > 1) c.violations.push(`DUPLICATE side effect: ${eff.length} effects`);
    if (c.followups > 1) c.violations.push(`follow-up ${follow} delivered ${c.followups}×`);
    if (c.final === 'done' && eff.length !== 1) c.violations.push(`done but ${eff.length} effects`);
    if (c.final === 'failed' && eff.length !== 0) c.violations.push(`reported failed but the effect happened`);
    if (!TERMINAL.has(c.final)) c.violations.push(`STUCK in '${c.final}'`);
    if (c.final === 'needs_review') c.violations.push('still in review after 15 reviewer passes');
    if (c.confirmed && c.final === 'idle') c.violations.push('confirmed request lost');
  }
  return { round: r, globalFaults: globalFired.sort(), cases };
}

// ── Main ─────────────────────────────────────────────────────────────────────
const t0 = Date.now();
// Refuse to run next to leftovers from an earlier run (they would answer on our ports).
for (const sv of servers) if (await alive(sv.base)) throw new Error(`port ${sv.port} is already serving — stop the old server first`);
if (await fetch(`http://127.0.0.1:${PY_PORT}/`).then(() => true, () => false)) throw new Error(`port ${PY_PORT} is busy`);
startService();
await sleep(800);
for (const sv of servers) await startServer(sv);
const mig = migrator();
const d = await api('PUT', '/v1/definitions', { id: 'chaos-v1', definition: definition(1) });
if (d.status !== 201) throw new Error(`deploy failed: ${JSON.stringify(d.body)}`);
const rounds = [];
for (let r = 1; r <= ROUNDS; r++) {
  const res = await round(r);
  rounds.push(res);
  const v = res.cases.filter((c) => c.violations.length).length;
  console.log(`round ${String(r).padStart(2)}  global=[${res.globalFaults.join(',') || '-'}]  cases=${res.cases.length}  violations=${v}`);
  writeFileSync(OUT + '.partial', JSON.stringify(rounds.flatMap((x) => x.cases.filter((c) => c.violations.length).map((c) => ({ ...c, globalFaults: x.globalFaults }))), null, 1));
}
mig.kill('SIGKILL'); py?.kill('SIGKILL'); serviceHeldDown = Infinity; py = null;
for (const sv of servers) sv.proc?.kill('SIGKILL');

const all = rounds.flatMap((x) => x.cases.map((c) => ({ ...c, globalFaults: x.globalFaults })));
const report = { seed: SEED, backend: BACKEND, intensity: arg('intensity', 'normal'), rounds: ROUNDS, cases: all.length, minutes: +((Date.now() - t0) / 60000).toFixed(1),
  counters, probabilities: { FAULTS, GLOBAL, CLIENT }, violations: all.filter((c) => c.violations.length), all };
writeFileSync(OUT, JSON.stringify(report, null, 1));
const by = (key) => { const m = {}; for (const c of all) { const k = key(c); m[k] ??= { cases: 0, done: 0, failed: 0, 'needed a human': 0, 'human decisions': 0, 'duplicate effects': 0, violations: 0 }; const x = m[k]; x.cases++; if (c.final === 'done') x.done++; if (c.final === 'failed') x.failed++; if (c.reviewed) { x['needed a human']++; x['human decisions'] += c.reviewed.length; } if ((c.effects ?? 0) > 1) x['duplicate effects']++; if (c.violations.length) x.violations++; } return m; };
console.log(`\nlogs and ground truth: ${dir}`);
console.log(`\n${all.length} cases, ${report.violations.length} with violations, ${report.minutes} min, counters ${JSON.stringify(counters)}`);
console.table(by((c) => c.delivery));
console.table(by((c) => c.faults[0]));
console.table(by((c) => (c.globalFaults.length ? c.globalFaults.join('+') : 'none')));
for (const c of report.violations.slice(0, 20)) console.log('VIOLATION', JSON.stringify({ round: c.round, idx: c.idx, event: c.event, faults: c.faults, global: c.globalFaults, final: c.final, effects: c.effects, followups: c.followups, reviewed: c.reviewed, attempts: c.attempts, requests: c.requests, v: c.violations }));
process.exit(report.violations.length ? 1 : 0);
