#!/usr/bin/env node
/**
 * test/chaos/workflow/simulate.mjs — generic workflow chaos simulation.
 *
 *   node test/chaos/workflow/simulate.mjs --seed 7 --rounds 10 --per-round 30 --backend sqlite
 *   node test/chaos/workflow/simulate.mjs --backend postgres|cluster --db postgresql://…/empty_db
 *   … --intensity hard
 *
 * Generates workflows for several unrelated domains (orders, CI pipelines, support
 * tickets, IoT devices, clinical trials, claims, hiring, moderation) — nested and
 * parallel states, guards, eventless transitions, timers, side-effecting actions with
 * different delivery modes — and runs many actors through them with random client
 * behaviour while faults hit every part of the system, several at once:
 *
 *   per action attempt   slow · rejected · succeeds after the timeout · hangs ·
 *                        service crashes before / after the effect
 *   per round (global)   API server kill -9 · service crash · service outage ·
 *                        migrate-worker kill · scheduler kill · database connection
 *                        drop (Postgres) · new versions deployed mid-flight (add a
 *                        step / rename a state / reroute for one history / copy a
 *                        context field) · event storms
 *   per client event     duplicates (same idempotency key) · concurrent sends ·
 *                        unknown events · payloads that flip guards
 *
 * Every actor is then rebuilt from its audit trail by the oracle (oracle.mjs) and
 * compared with the live actor; APV routing, side effects, liveness and timers are
 * checked too. Same seed → same plan.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, openSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS, FIELDS, generateWorkflow, evolve, makeRng } from './generator.mjs';
import { replayActor } from './oracle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SEED = Number(arg('seed', 7)), ROUNDS = Number(arg('rounds', 10)), PER_ROUND = Number(arg('per-round', 30));
const BACKEND = arg('backend', 'sqlite'), DB_URL = arg('db', ''), N_WORKFLOWS = Number(arg('workflows', 4));
const HARD = arg('intensity', 'normal') === 'hard';
const OUT = arg('out', join(ROOT, `workflow-chaos-${BACKEND}-seed${SEED}.json`));
if (BACKEND !== 'sqlite' && !DB_URL.startsWith('postgres')) throw new Error('--db postgres://… (empty database) required');

const rng = makeRng(SEED);
const { pick, pickW, int, chance, rnd } = rng;
const uni = (a, b) => a + rnd() * (b - a);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ── Probabilities ────────────────────────────────────────────────────────────
const FAULTS = [['ok', HARD ? 0.2 : 0.55], ['slow', 0.12], ['error_4xx', 0.1], ['late_success', 0.06],
  ['hang_no_effect', 0.05], ['crash_after', 0.05], ['crash_before', 0.04]];
const scale = HARD ? 2 : 1;
const GLOBAL = Object.fromEntries(Object.entries({
  server_kill: 0.3, service_crash: 0.2, service_outage: 0.15, migrate_worker_kill: 0.2,
  scheduler_kill: 0.2, db_blip: BACKEND === 'sqlite' ? 0 : 0.2, deploy: 0.5, second_deploy: 0.2, event_storm: 0.15,
}).map(([k, p]) => [k, Math.min(0.9, p * (k.includes('deploy') ? 1 : scale))]));
const CLIENT = { duplicate: 0.2, concurrent: 0.25, unknown_event: 0.05, payload: 0.6 };

// ── Processes ────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), `sk-wfchaos-${BACKEND}-`));
mkdirSync(join(dir, 'out'), { recursive: true });
const F = { ledger: join(dir, 'ledger.jsonl'), effects: join(dir, 'effects.jsonl'), attempts: join(dir, 'attempts.jsonl'),
  store: join(dir, 'jobs.sqlite'), actions: join(dir, 'actions.json') };
const PY_PORT = 8290, SECRET = 'wf-chaos-secret', ADMIN = 'wf-chaos-admin-key-123456';
const servers = Array.from({ length: BACKEND === 'cluster' ? 2 : 1 }, (_, i) => ({ i, port: 3290 + i, proc: null, base: `http://127.0.0.1:${3290 + i}` }));
const baseEnv = {
  ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', STATEKEEP_ENCRYPTION_KEY: '4d'.repeat(32), STATEKEEP_ADMIN_KEY: ADMIN,
  STATEKEEP_REMOTE_URL: `http://127.0.0.1:${PY_PORT}/statekeep`, STATEKEEP_REMOTE_SECRET: SECRET,
  STATEKEEP_REMOTE_TIMEOUT_MS: '1500', STATEKEEP_ACTION_LEASE_MS: '2000', STATEKEEP_ACTION_BACKOFF_MAX_MS: '4000',
  LOG_DIR: join(dir, 'logs'), STATEKEEP_DATA_DIR: join(dir, 'data'), STATEKEEP_INTERNAL_URL: servers[0].base,
  ...(BACKEND === 'sqlite' ? { STATEKEEP_DB_PATH: join(dir, 'wf.db') } : { STATEKEEP_DB_URL: DB_URL }),
  ...(BACKEND === 'cluster' ? { STATEKEEP_CLUSTER: 'true', STATEKEEP_NODE_TTL_MS: '2000' } : {}),
};
delete baseEnv.STATEKEEP_API_KEY;
if (BACKEND === 'sqlite') delete baseEnv.STATEKEEP_DB_URL;
const counters = { serverKills: 0, serviceCrashes: 0, outages: 0, migrateWorkerKills: 0, schedulerKills: 0, dbBlips: 0,
  deploys: 0, deployRefused: 0, storms: 0, reviews: 0, clientRetries: 0 };

const logTo = (name) => openSync(join(dir, 'out', name), 'a');
const alive = async (base) => { try { return (await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } };
async function startServer(sv) {
  const l = logTo(`server${sv.i}.log`);
  sv.proc = spawn(process.execPath, ['src/api/server.js'], { cwd: ROOT, stdio: ['ignore', l, l],
    env: { ...baseEnv, PORT: String(sv.port), STATEKEEP_NODE_ID: `node${sv.i}`, STATEKEEP_NODE_URL: sv.base } });
  const me = sv.proc;
  // A server that dies on its own (not killed by the simulation) is a finding: count it,
  // keep its log, bring it back so the run continues.
  me.on('exit', (code, signal) => {
    if (stopping || me !== sv.proc || me.intentional) return;
    counters.unexpectedServerExits = (counters.unexpectedServerExits ?? 0) + 1;
    crashes.push({ what: `server${sv.i}`, code, signal, at: Date.now() });
    setTimeout(() => { if (me === sv.proc && !stopping) startServer(sv).catch(() => {}); }, 1000);
  });
  for (let k = 0; k < 150 && !(await alive(sv.base)); k++) await sleep(100);
  if (sv.proc.exitCode !== null) throw new Error(`server ${sv.i} exited at startup`);
}
const workers = {};
function startWorker(name, file) {
  const l = logTo(`${name}.log`);
  const w = spawn(process.execPath, [file], { cwd: ROOT, stdio: ['ignore', l, l], env: { ...baseEnv, PORT: String(servers[0].port) } });
  workers[name] = w;
  w.on('exit', (code, signal) => {
    if (stopping || workers[name] !== w || w.intentional) return;
    counters.unexpectedWorkerExits = (counters.unexpectedWorkerExits ?? 0) + 1;
    crashes.push({ what: name, code, signal, at: Date.now() });
    setTimeout(() => { if (workers[name] === w && !stopping) startWorker(name, file); }, 1000);
  });
}
let py = null, heldDownUntil = 0, stopping = false;
const crashes = [];
function startService() {
  const l = logTo('service.log');
  py = spawn('python3', ['test/chaos/workflow/service.py'], { cwd: ROOT, stdio: ['ignore', l, l],
    env: { ...process.env, PORT: String(PY_PORT), STATEKEEP_REMOTE_SECRET: SECRET, JOB_STORE: F.store, ACTIONS_FILE: F.actions,
      LEDGER_FILE: F.ledger, EFFECTS_FILE: F.effects, ATTEMPTS_FILE: F.attempts } });
  const me = py;
  py.on('exit', () => { if (me !== py || stopping) return; setTimeout(() => { if (me === py && !stopping) startService(); }, Math.max(uni(200, 1000), heldDownUntil - Date.now())); });
}

// ── Database (read-only checks) ──────────────────────────────────────────────
let dbq;
if (BACKEND === 'sqlite') {
  const { default: Database } = await import('better-sqlite3');
  let db = null;
  dbq = async (sql, params = []) => { db ??= new Database(join(dir, 'wf.db'), { readonly: true, fileMustExist: true }); return db.prepare(sql.replace(/\$\d+/g, '?')).all(...params); };
} else {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: DB_URL, max: 3 });
  dbq = async (sql, params = []) => (await pool.query(sql, params)).rows;
}

// ── HTTP client with retries ─────────────────────────────────────────────────
const liveServers = () => servers.filter((x) => x.proc && x.proc.exitCode === null && x.proc.signalCode === null);
async function api(method, path, body, { retry = true, deadline = 90_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const sv = pick(liveServers().length ? liveServers() : servers);
    try {
      const r = await fetch(sv.base + path, { method, headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
      const data = await r.json().catch(() => ({}));
      if (r.status < 500 && r.status !== 429) return { status: r.status, body: data };
      if (!retry) return { status: r.status, body: data };
    } catch (err) { if (!retry) return { status: 0, body: { error: err.message } }; }
    if (Date.now() - t0 > deadline) return { status: 0, body: { error: 'client gave up' } };
    counters.clientRetries++;
    await sleep(uni(100, 400));
  }
}
async function trailOf(id) {
  const out = [];
  let after = 0;
  for (;;) {
    const r = await api('GET', `/v1/actors/${id}/events?limit=200&after=${after}`);
    if (r.status !== 200) throw new Error(`history ${r.status}`);
    out.push(...r.body.events);
    if (!r.body.hasMore) return out;
    after = r.body.nextCursor;
  }
}

// ── Workflows and versions ───────────────────────────────────────────────────
const workflows = [];
const defs = new Map();                 // definitionId → oracle record
const latest = new Map();               // workflow id → latest definition id
async function deploy(wf, id, body, extra) {
  const startAt = Date.now();
  let r = await api('PUT', '/v1/definitions', { id, ...body });
  if (r.status === 409 && r.body?.confirmToken) {
    if (!chance(0.5)) { counters.deployRefused++; return false; }
    r = await api('PUT', '/v1/definitions', { id, ...body, confirmToken: r.body.confirmToken });
  }
  if (r.status !== 201 && r.status !== 200) { counters.deployRefused++; return { refused: r.status, body: r.body }; }
  const stored = await api('GET', `/v1/definitions/${id}`);
  defs.set(id, { json: stored.body.definition ?? stored.body.definitionJson ?? body.definition, deployedAt: r.body.deployedAt,
    parentId: body.parentId ?? null, workflow: wf.id, historyPath: body.historyPath ?? null, stateMapping: body.stateMapping ?? null,
    contextTransform: body.contextTransform ?? null, startAt, ackAt: Date.now(), kind: extra?.kind ?? 'v1' });
  latest.set(wf.id, id);
  return true;
}

// ── Actors ───────────────────────────────────────────────────────────────────
const actors = [];                      // { id, wf, spawn, acked:Set, sent, profile, round }
function faultProfile(wf) {
  return Object.fromEntries(Object.keys(wf.actions).map((a) => [a, [pickW(FAULTS), pickW(FAULTS), pickW(FAULTS)]]));
}
async function runClient(a, script) {
  const pending = [];
  for (const step of script) {
    await sleep(step.delay);
    const body = { type: step.type, idempotencyKey: `k-${step.eid}`, payload: { ...step.payload, _eid: step.eid } };
    const send = async () => {
      const r = await api('POST', `/v1/actors/${a.id}/event`, body);
      if (r.status === 200) a.acked.add(step.eid);
      else a.rejected.push({ eid: step.eid, status: r.status, code: r.body?.code });
    };
    const p = Promise.all([send(), ...(step.duplicate ? [send()] : [])]);
    if (step.concurrent) pending.push(p); else await p;
  }
  await Promise.all(pending);
}

// ── Faults ───────────────────────────────────────────────────────────────────
async function globalFault(kind, roundActors) {
  if (kind === 'server_kill') {
    const sv = pick(servers); counters.serverKills++;
    if (sv.proc) sv.proc.intentional = true;
    sv.proc?.kill('SIGKILL'); await sleep(uni(300, 1500)); await startServer(sv);
  } else if (kind === 'service_crash') { counters.serviceCrashes++; py?.kill('SIGKILL'); }
  else if (kind === 'service_outage') { counters.outages++; heldDownUntil = Date.now() + uni(2000, 5000); py?.kill('SIGKILL'); }
  else if (kind === 'migrate_worker_kill') { counters.migrateWorkerKills++; if (workers.migrate) workers.migrate.intentional = true; workers.migrate?.kill('SIGKILL'); await sleep(uni(300, 2000)); startWorker('migrate', 'src/workers/migrate-worker.js'); }
  else if (kind === 'scheduler_kill') { counters.schedulerKills++; if (workers.scheduler) workers.scheduler.intentional = true; workers.scheduler?.kill('SIGKILL'); await sleep(uni(300, 2000)); startWorker('scheduler', 'src/workers/scheduler-worker.js'); }
  else if (kind === 'db_blip') {
    counters.dbBlips++;
    await dbq(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`).catch(() => {});
  } else if (kind === 'deploy' || kind === 'second_deploy') {
    const wf = pick(workflows);
    const cur = latest.get(wf.id);
    const onCur = actors.filter((x) => x.wf === wf && x.lastDef === cur);
    const livePaths = [];
    for (const x of onCur.slice(0, 6)) {
      try { const t = await trailOf(x.id); const s = await api('GET', `/v1/actors/${x.id}`); livePaths.push(replayActor({ actor: s.body, trail: t, spawn: x.spawn, defs, sentEids: { acked: [] } }).history); } catch {}
    }
    const e = evolve(rng, wf, defs.get(cur).json, livePaths);
    if (!e) return;
    const n = Number(cur.split('-v').pop()) + 1;
    const id = `${wf.id}-v${n}`;
    const ok = await deploy(wf, id, { parentId: cur, definition: e.definition,
      ...(e.stateMapping ? { stateMapping: e.stateMapping } : {}), ...(e.contextTransform ? { contextTransform: e.contextTransform } : {}),
      ...(e.historyPath ? { historyPath: e.historyPath } : {}) }, { kind: e.kind });
    if (ok === true) counters.deploys++;
  } else if (kind === 'event_storm') {
    counters.storms++;
    await Promise.all(roundActors.filter((x) => x.id).slice(0, 12).map((x) => api('POST', `/v1/actors/${x.id}/event`, { type: pick(x.wf.events) }, { retry: false })));
  }
}

// ── Checks ───────────────────────────────────────────────────────────────────
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
const TERMINAL_JOB = new Set(['done', 'failed']);

async function settle(list, maxMs) {
  const t0 = Date.now();
  let prev = '';
  while (Date.now() - t0 < maxMs) {
    const ids = list.map((a) => a.id);
    if (!ids.length) return true;
    const inList = `(${ids.map((_, i) => `$${i + 1}`).join(',')})`;
    const jobs = await dbq(`SELECT count(*) AS n FROM action_jobs WHERE status IN ('pending','running') AND actor_id IN ${inList}`, ids).catch(() => [{ n: 1 }]);
    const timers = await dbq(`SELECT count(*) AS n FROM scheduled_events WHERE status='pending' AND actor_id IN ${inList}`, ids).catch(() => [{ n: 1 }]);
    const states = [];
    for (const a of list) { const s = await api('GET', `/v1/actors/${a.id}`); states.push(JSON.stringify([s.body.definitionId, s.body.stateValue, s.body.status])); }
    const snap = states.join('|');
    if (Number(jobs[0].n) === 0 && Number(timers[0].n) === 0 && snap === prev) return true;
    prev = snap;
    await sleep(1500);
  }
  return false;
}

async function review(list) {
  const mine = new Set(list.map((a) => a.id));
  for (let pass = 0; pass < 15; pass++) {
    const jobs = ((await api('GET', '/v1/action-jobs?outcome=unknown&limit=500')).body.jobs ?? []).filter((j) => mine.has(j.actorId));
    if (!jobs.length) return;
    await sleep(3000);
    const truth = [...lines(F.ledger), ...lines(F.effects)];
    for (const j of jobs) {
      counters.reviews++;
      const happened = truth.some((e) => e.job === j.id);
      const a = actors.find((x) => x.id === j.actorId);
      a.reviews.push(happened ? 'happened' : 'did-not-happen');
      // Same rule as the service (service.py MAX_FOLLOWUPS): only an actor's first 3 jobs
      // of an action report a follow-up, so a looping workflow cannot loop forever
      // through the review queue either.
      const order = [...new Set(lines(F.attempts).filter((x) => x.action === j.actionName && x.actorId === j.actorId).map((x) => x.job))];
      const follow = order.indexOf(j.id) < 3 ? a.wf.actions[j.actionName]?.followUp : null;
      await api('POST', `/v1/action-jobs/${j.id}/resolve`, happened ? { happened: true, ...(follow ? { event: { type: follow, _job: j.id } } : {}) } : { happened: false });
    }
    await settle(list, 60_000);
  }
}

// A deployment whose answer the client never got (the server was killed, the request
// timed out) may still have committed. Learn such versions from the server when an actor
// refers to them; there was no acknowledgement, so no completeness deadline applies.
async function ensureDefs(ids) {
  for (const id of ids) {
    if (!id || defs.has(id)) continue;
    const r = await api('GET', `/v1/definitions/${id}`);
    if (r.status !== 200) continue;
    const b = r.body; const json = b.definitionJson ?? b.definition ?? {};
    const root = [...defs].find(([rid, d]) => !d.parentId && rid === (b.machineId ?? b.machine_id));
    defs.set(id, { json, deployedAt: b.deployedAt, parentId: b.parentId ?? null, workflow: root?.[1].workflow ?? '?',
      historyPath: Array.isArray(json._historyPath) && json._historyPath.length ? json._historyPath : null,
      stateMapping: json._stateMapping ?? null, contextTransform: json._contextTransform ?? null,
      startAt: 0, ackAt: Infinity, kind: 'unacknowledged' });
    counters.unacknowledgedDeploys = (counters.unacknowledgedDeploys ?? 0) + 1;
  }
}

async function check(a) {
  const v = [];
  const live = (await api('GET', `/v1/actors/${a.id}`)).body;
  a.lastDef = live.definitionId;
  let trail;
  try { trail = await trailOf(a.id); } catch (err) { return [`history unavailable: ${err.message}`]; }
  await ensureDefs([a.spawn.definitionId, live.definitionId, ...trail.flatMap((e) => [e.payload?.toDefinitionId, e.payload?.fromDefinitionId])]);
  const r = replayActor({ actor: live, trail, spawn: a.spawn, defs, sentEids: { acked: [...a.acked] } });
  v.push(...r.violations);
  a.notes = { ...r.notes, transitions: r.notes.transitions.length, finalDef: live.definitionId, finalState: live.stateValue, status: live.status };
  // side effects: at most one per job; follow-up at most once per job
  const truth = [...lines(F.ledger), ...lines(F.effects)].filter((e) => e.actorId === a.id);
  const perJob = new Map(); for (const e of truth) perJob.set(e.job, (perJob.get(e.job) ?? 0) + 1);
  for (const [job, n] of perJob) if (n > 1) v.push(`DUPLICATE side effect: job ${job} happened ${n}×`);
  const follows = new Map(); for (const ev of trail) if (ev.payload?._job) follows.set(ev.payload._job, (follows.get(ev.payload._job) ?? 0) + 1);
  for (const [job, n] of follows) if (n > 1) v.push(`follow-up of job ${job} delivered ${n}×`);
  // liveness
  const jobs = await dbq(`SELECT id, status, outcome FROM action_jobs WHERE actor_id = $1`, [a.id]);
  for (const j of jobs) {
    if (!TERMINAL_JOB.has(j.status)) v.push(`action job ${j.id} stuck (${j.status})`);
    if (j.outcome === 'unknown') v.push(`action job ${j.id} left in review`);
  }
  const overdue = await dbq(`SELECT event_type, fire_at FROM scheduled_events WHERE actor_id = $1 AND status = 'pending' AND fire_at < $2`, [a.id, Date.now() - 10_000]);
  for (const t of overdue) v.push(`timer ${t.event_type} overdue by ${Math.round((Date.now() - Number(t.fire_at)) / 1000)}s`);
  if (live.status === 'needs_rescue') v.push('actor tagged needs_rescue (no unmappable change was deployed)');
  a.effects = truth.length;
  return v;
}

// ── One round ────────────────────────────────────────────────────────────────
async function round(r) {
  const plan = Object.entries(GLOBAL).filter(([, p]) => chance(p)).map(([k]) => [k, uni(0, 6000)]);
  const roundActors = Array.from({ length: PER_ROUND }, (_, i) => {
    const wf = pick(workflows);
    const ctx = Object.fromEntries(FIELDS.map((f) => [f, int(0, 6)]));
    const a = { round: r, idx: i, wf, acked: new Set(), rejected: [], reviews: [], profile: faultProfile(wf),
      spawn: { definitionId: latest.get(wf.id), initialContext: { ...ctx, _faults: null } } };
    a.spawn.initialContext._faults = a.profile;
    const n = int(4, 12);
    a.script = Array.from({ length: n }, (_, k) => ({
      eid: `${r}.${i}.${k}`, delay: uni(20, 400),
      type: chance(CLIENT.unknown_event) ? 'PING' : pick(wf.events),
      payload: chance(CLIENT.payload) ? Object.fromEntries(FIELDS.filter(() => chance(0.5)).map((f) => [f, int(0, 7)])) : {},
      duplicate: chance(CLIENT.duplicate), concurrent: chance(CLIENT.concurrent),
    }));
    a.startDelay = uni(0, 3000);
    return a;
  });
  const fired = [];
  const chaos = plan.map(async ([kind, at]) => { await sleep(at); fired.push(kind); await globalFault(kind, roundActors).catch((e) => fired.push(`${kind}!${e.message}`)); });
  await Promise.all(roundActors.map(async (a) => {
    await sleep(a.startDelay);
    // Most clients ask for "the newest version" (the family id); some pin the version
    // they know about — which, during a deploy, may already be one behind.
    const family = [...defs].find(([, d]) => d.workflow === a.wf.id && !d.parentId)[0];
    a.spawn.pinned = chance(0.2);
    a.spawn.definitionId = a.spawn.pinned ? latest.get(a.wf.id) : family;
    const s = await api('POST', '/v1/actors', { definitionId: a.spawn.definitionId, initialContext: a.spawn.initialContext,
      idempotencyKey: `spawn-${a.round}-${a.idx}-${SEED}` });
    a.spawn.ackAt = Date.now();
    a.id = s.body.id;
    if (!a.id) { a.spawnError = s; return; }
    // (a workflow's first version id is also its family id: spawning with it means
    //  "the newest version", so record what the server actually chose)
    if (s.body.definitionId) a.spawn.definitionId = s.body.definitionId;
    actors.push(a);
    await runClient(a, a.script);
  }));
  await Promise.all(chaos);
  const live = roundActors.filter((a) => a.id);
  await settle(live, 120_000);
  await review(live);
  await settle(live, 60_000);
  for (const a of live) a.violations = await check(a);
  return { round: r, globalFaults: fired.sort(), actors: roundActors };
}

// ── Main ─────────────────────────────────────────────────────────────────────
const t0 = Date.now();
for (const sv of servers) if (await alive(sv.base)) throw new Error(`port ${sv.port} busy — stop the old server first`);
const domains = rng.shuffle(Object.keys(DOMAINS)).slice(0, N_WORKFLOWS);
const allActions = {};
for (const d of domains) {
  const wf = generateWorkflow(rng, d, 'x');
  wf.id = d;
  workflows.push(wf);
  Object.assign(allActions, wf.actions);
}
writeFileSync(F.actions, JSON.stringify(allActions));
startService();
await sleep(800);
for (const sv of servers) await startServer(sv);
startWorker('migrate', 'src/workers/migrate-worker.js');
startWorker('scheduler', 'src/workers/scheduler-worker.js');
for (const wf of workflows) {
  const ok = await deploy(wf, `${wf.id}-v1`, { definition: wf.definition });
  if (ok !== true) throw new Error(`v1 deploy failed for ${wf.id}: ${JSON.stringify(ok)}`);
}
const rounds = [];
for (let r = 1; r <= ROUNDS; r++) {
  const res = await round(r);
  rounds.push(res);
  const bad = res.actors.filter((a) => a.violations?.length).length;
  console.log(`round ${String(r).padStart(2)}  global=[${res.globalFaults.join(',') || '-'}]  actors=${res.actors.length}  violations=${bad}`);
  for (const a of res.actors) for (const v of a.violations ?? []) console.log(`    ${a.wf.id} ${a.id}: ${v}`);
}
// Final pass: every actor ever created, after all later deploys and faults
for (const sv of servers) if (!(await alive(sv.base))) await startServer(sv);
const everyone = actors;
await settle(everyone, 120_000);
await review(everyone);
const final = [];
for (const a of everyone) { const v = await check(a); if (v.length) final.push({ a, v }); }
// A spawn the server refused (e.g. its database connection was dropped) is a correct,
// honest answer — but only if no actor was created anyway behind the client's back.
const known = new Set(everyone.map((a) => a.id));
const orphans = (await dbq(`SELECT id FROM actors`, [])).map((r) => r.id).filter((id) => !known.has(id));
const refusedSpawns = rounds.flatMap((x) => x.actors).filter((a) => !a.id).length;
if (orphans.length) final.push({ a: { id: orphans[0], round: 0, wf: { id: '-' } }, v: [`${orphans.length} actor(s) exist that no client was told about (a refused spawn created them anyway)`] });

stopping = true;
py?.kill('SIGKILL'); for (const w of Object.values(workers)) w.kill('SIGKILL'); for (const sv of servers) sv.proc?.kill('SIGKILL');
const all = rounds.flatMap((x) => x.actors.map((a) => ({ round: a.round, idx: a.idx, workflow: a.wf.id, features: a.wf.features, id: a.id,
  faults: a.profile, script: a.script.length, globalFaults: x.globalFaults, notes: a.notes, reviews: a.reviews, effects: a.effects,
  acked: a.acked.size, rejected: a.rejected.length, violations: a.violations ?? [], ...(a.spawnError ? { spawnRefused: a.spawnError.body } : {}) })));
const report = { seed: SEED, backend: BACKEND, intensity: HARD ? 'hard' : 'normal', minutes: +((Date.now() - t0) / 60000).toFixed(1),
  workflows: workflows.map((w) => ({ id: w.id, features: w.features, actions: w.actions })),
  versions: [...defs.entries()].map(([id, d]) => ({ id, parent: d.parentId, kind: d.kind, historyPath: d.historyPath, stateMapping: d.stateMapping })),
  counters, crashes, finalViolations: final.map(({ a, v }) => ({ id: a.id, round: a.round, workflow: a.wf.id, v })),
  actors: all, dir };
writeFileSync(OUT, JSON.stringify(report, null, 1));
const perRound = all.filter((x) => x.violations.length).length;
console.log(`\n${all.length} actors, ${perRound} with violations at round end, ${final.length} at the final check; ${report.minutes} min`);
console.log(JSON.stringify({ ...counters, refusedSpawns, orphans: orphans.length }));
if (crashes.length) console.log(`UNEXPECTED PROCESS EXITS: ${JSON.stringify(crashes)}`);
console.log(`versions deployed: ${report.versions.length - workflows.length} (${report.versions.filter((x) => x.historyPath).length} history-targeted, ${report.versions.filter((x) => x.stateMapping).length} renames)`);
const kinds = {}; for (const x of all) for (const v of x.violations) { const k = v.replace(/[0-9a-f-]{36}/g, '…').replace(/\d+(ms|s|×)/g, 'N$1').slice(0, 90); kinds[k] = (kinds[k] ?? 0) + 1; }
for (const { v } of final) for (const x of v) { const k = 'FINAL ' + x.replace(/[0-9a-f-]{36}/g, '…').replace(/\d+(ms|s|×)/g, 'N$1').slice(0, 90); kinds[k] = (kinds[k] ?? 0) + 1; }
console.table(Object.entries(kinds).sort((p, q) => q[1] - p[1]).slice(0, 25).map(([k, n]) => ({ violation: k, cases: n })));
console.log(`logs and ground truth: ${dir}`);
process.exit(perRound + final.length + crashes.length ? 1 : 0);
