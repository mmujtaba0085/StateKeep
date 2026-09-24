/**
 * @statekeep/durable — code-first durable workflows stored in StateKeep, with
 * history-based version routing.
 *
 *   const engine = createEngine({
 *     url: 'http://localhost:3001', apiKey,
 *     workflows: {
 *       onboarding: {
 *         v1: async (ctx, input) => {
 *           const acct = await ctx.step('createAccount', () => accounts.create(input));
 *           await ctx.waitForEvent('EMAIL_VERIFIED');
 *           await ctx.step('sendWelcome', () => mail.welcome(acct.id));
 *           return { accountId: acct.id };
 *         },
 *         v2: async (ctx, input) => { … adds a 'kycCheck' step … },
 *       },
 *     },
 *     releases: [{ workflow: 'onboarding', from: 'v1', to: 'v2' }],
 *   });
 *   await engine.setup();
 *   const runId = await engine.start('onboarding', { email }, { version: 'v2' });
 *   await engine.signal(runId, 'EMAIL_VERIFIED', { at: Date.now() });
 *   await engine.resumeAll();                       // after a crash/deploy, and for due timers
 *   await engine.preview({ workflow: 'onboarding', from: 'v1', to: 'v2' });  // dry run
 *
 * Execution model (same as Temporal/Restate-style engines): the workflow function
 * is re-run from the top on every resume; completed steps are replayed from the
 * run's journal instead of executed. So the function must be deterministic outside
 * `ctx.step` — put I/O, randomness and clocks inside steps.
 *
 * Storage: each run is a StateKeep actor (definition `sk-durable-run-v1`). Every
 * completed step is a committed event (`STEP`) carrying its result, with
 * idempotency key `<runId>:<index>`, so the run's event history is its audit trail.
 * Steps are at-least-once (a crash between the side effect and the commit repeats
 * it); `ctx.step` passes `{ key }` for downstream dedupe.
 *
 * Version routing (the part other engines leave to "patching" code by hand):
 *   - A release { workflow, from, to } moves runs on `from` to `to` at their next
 *     checkpoint (resume, or right after a step completes) — but only if the new
 *     code, replayed against the run's journal, asks for exactly the same steps
 *     in the same order. Runs for which that is not true stay on `from` and keep
 *     running the old code; `preview()` lists them with the reason.
 *   - `when: ['createAccount', 'kycCheck']` limits a release to runs whose
 *     completed steps are exactly that sequence (like StateKeep's historyPath).
 *   - `renameSteps: { old: 'new' }` lets runs cross a step rename (like stateMapping).
 *   - Completed and failed runs never move. Releases chain (v1 → v2 → v3).
 */

export const RUN_DEFINITION_ID = 'sk-durable-run-v1';
export const RUN_DEFINITION = {
  id: 'sk-durable-run',
  initial: 'running',
  states: {
    running: { on: { STEP: 'running', MOVE: 'running', SIGNAL: 'running', WAIT: 'waiting', DONE: 'completed', FAIL: 'failed' } },
    waiting: { on: { STEP: 'running', MOVE: 'waiting', SIGNAL: 'waiting', WAIT: 'waiting' } },
    completed: { type: 'final' },
    failed: { type: 'final' },
  },
};

class Suspend extends Error { constructor() { super('suspended'); } }
class Frontier extends Error { constructor() { super('frontier'); } }
class Mismatch extends Error {}
class MoveNow extends Error { constructor(release) { super('move'); this.release = release; } }
class Conflict extends Error { constructor() { super('another worker advanced this run'); } }

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/** The journal of a run, from its actor context: [{ kind, name, result }]. */
export function journalOf(context) {
  const out = [];
  for (let i = 0; i < (context.stepCount ?? 0); i++) out.push(context[`s${i}`]);
  return out;
}

/**
 * Replay `fn` against `journal` without side effects. Returns { ok: true } when
 * the code asks for exactly the journaled steps (it may continue past the end),
 * or { ok: false, reason }.
 */
export async function replayCheck(fn, input, journal, renameSteps = {}) {
  const renamed = journal.map((e) => ({ ...e, name: renameSteps[e.name] ?? e.name }));
  let i = 0;
  const expect = (kind, name) => {
    if (i >= renamed.length) throw new Frontier();
    const e = renamed[i];
    if (e.kind !== kind || e.name !== name) {
      throw new Mismatch(`new code expects ${kind} "${name}" at #${i}, but the run recorded ${e.kind} "${e.name}"`);
    }
    i++;
    return clone(e.result);
  };
  const ctx = {
    runId: 'replay-check', version: null,
    step: async (name) => expect('step', name),
    waitForEvent: async (name) => expect('signal', name),
    sleep: async () => expect('timer', 'sleep'),
  };
  try {
    await fn(ctx, clone(input));
    if (i < renamed.length) return { ok: false, reason: `new code finishes after ${i} steps; the run already recorded ${renamed.length}` };
    return { ok: true };
  } catch (err) {
    if (err instanceof Frontier) return { ok: true };
    if (err instanceof Mismatch) return { ok: false, reason: err.message };
    return { ok: false, reason: `new code threw during replay: ${err.message}` };
  }
}

export function createEngine({ url, apiKey, workflows, releases = [], fetch: f = globalThis.fetch, log = () => {} }) {
  const base = url.replace(/\/$/, '');
  for (const r of releases) {
    if (!workflows[r.workflow]?.[r.from] || !workflows[r.workflow]?.[r.to]) throw new Error(`release ${r.workflow} ${r.from} → ${r.to}: unknown version`);
    for (const k of Object.keys(r.renameSteps ?? {})) if (FORBIDDEN.has(k)) throw new Error('unsafe renameSteps key');
  }
  const running = new Map();          // runId → promise (one executor per run per process)

  async function api(method, path, body) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (apiKey) headers['x-api-key'] = apiKey;
    const res = await f(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status, body: data });
    return data;
  }
  const event = (runId, type, payload, idempotencyKey) =>
    api('POST', `/v1/actors/${runId}/event`, { type, payload, ...(idempotencyKey ? { idempotencyKey } : {}) });

  function releaseFor(run, journal) {
    for (const r of releases) {
      if (r.workflow !== run.workflow || r.from !== run.version) continue;
      if (r.when && !(r.when.length === journal.length && r.when.every((n, i) => (r.renameSteps?.[journal[i].name] ?? journal[i].name) === n))) continue;
      return r;
    }
    return null;
  }

  /** Apply every release that applies and is replay-safe. Returns the (maybe new) version. */
  async function route(runId, run, journal) {
    let version = run.version;
    for (let n = 0; n <= releases.length; n++) {
      const r = releaseFor({ ...run, version }, journal);
      if (!r) break;
      const check = await replayCheck(workflows[run.workflow][r.to], run.input, journal, r.renameSteps);
      if (!check.ok) { log(`[durable] ${runId} stays on ${version}: ${check.reason}`); break; }
      const renamed = {};
      journal.forEach((e, i) => { if (r.renameSteps?.[e.name]) renamed[`s${i}`] = { ...e, name: r.renameSteps[e.name] }; });
      await event(runId, 'MOVE', { version: r.to, ...renamed, [`moved_${r.from}`]: r.to });
      journal.forEach((e, i) => { if (renamed[`s${i}`]) journal[i] = renamed[`s${i}`]; });
      log(`[durable] ${runId} moved ${r.workflow} ${version} → ${r.to}`);
      version = r.to;
    }
    return version;
  }

  async function execute(runId) {
    const actor = await api('GET', `/v1/actors/${runId}`);
    if (['completed', 'failed'].includes(actor.stateValue)) return summarize(actor);
    const run = actor.context;
    const journal = journalOf(run);
    const version = await route(runId, run, journal);
    const fn = workflows[run.workflow]?.[version];
    if (!fn) throw new Error(`no code for ${run.workflow} ${version}`);

    let i = 0;
    let waiting = actor.stateValue === 'waiting';
    const record = async (entry, extra = {}) => {
      const r = await event(runId, 'STEP', { [`s${i}`]: entry, stepCount: i + 1, waitingFor: null, wakeAt: null, ...extra }, `${runId}:${i}`);
      if (r.idempotent) throw new Conflict();
      journal.push(entry); i++; waiting = false;
      // checkpoint: a release may apply now that this step is done
      const r2 = releaseFor({ ...run, version }, journal);
      if (r2 && (await replayCheck(workflows[run.workflow][r2.to], run.input, journal, r2.renameSteps)).ok) throw new MoveNow(r2);
    };
    const suspend = async ({ waitingFor, wakeAt = null }) => {
      // (re)record what the run waits for unless that is already stored — a moved run
      // may now wait for something else than it did under its old version
      if (!waiting || run.waitingFor !== waitingFor || (run.wakeAt ?? null) !== wakeAt) {
        await event(runId, 'WAIT', { waitingFor, wakeAt });
      }
      throw new Suspend();
    };
    const ctx = {
      runId, version, workflow: run.workflow,
      async step(name, body, { retries = 3 } = {}) {
        if (i < journal.length) {
          const e = journal[i];
          if (e.kind !== 'step' || e.name !== name) throw new Error(`non-deterministic workflow: expected ${e.kind} "${e.name}" at #${i}, code asked for step "${name}"`);
          i++; return clone(e.result);
        }
        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const result = clone(await body({ key: `${runId}:${i}`, attempt }));
            await record({ kind: 'step', name, result });
            return clone(result);
          } catch (err) {
            if (err instanceof Conflict || err instanceof MoveNow) throw err;
            lastErr = err;
            if (attempt < retries) await new Promise((res) => { setTimeout(res, Math.min(100 * 2 ** attempt, 2000)); });
          }
        }
        throw lastErr;
      },
      async waitForEvent(name) {
        if (i < journal.length) {
          const e = journal[i];
          if (e.kind !== 'signal' || e.name !== name) throw new Error(`non-deterministic workflow: expected ${e.kind} "${e.name}" at #${i}, code waited for "${name}"`);
          i++; return clone(e.result);
        }
        const inbox = (await api('GET', `/v1/actors/${runId}`)).context[`inbox_${name}`];
        if (inbox != null) {
          await record({ kind: 'signal', name, result: inbox.payload ?? null }, { [`inbox_${name}`]: null });
          return clone(inbox.payload ?? null);
        }
        return suspend({ waitingFor: name });
      },
      async sleep(ms) {
        if (i < journal.length) {
          const e = journal[i];
          if (e.kind !== 'timer') throw new Error(`non-deterministic workflow: expected ${e.kind} "${e.name}" at #${i}, code called sleep`);
          i++; return;
        }
        const cur = (await api('GET', `/v1/actors/${runId}`)).context;
        const wakeAt = (cur.waitingFor === '__timer' && cur.wakeAt) || Date.now() + ms;
        if (Date.now() >= wakeAt) return void (await record({ kind: 'timer', name: 'sleep', result: null }));
        return suspend({ waitingFor: '__timer', wakeAt });
      },
    };

    try {
      const output = clone(await fn(ctx, clone(run.input)));
      await event(runId, 'DONE', { output });
      return { runId, status: 'completed', version, output };
    } catch (err) {
      if (err instanceof Suspend) return { runId, status: 'waiting', version };
      if (err instanceof Conflict || err instanceof MoveNow) return execute(runId);
      await event(runId, 'FAIL', { error: String(err?.message ?? err) }).catch(() => {});
      return { runId, status: 'failed', version, error: String(err?.message ?? err) };
    }
  }

  function summarize(actor) {
    const c = actor.context;
    return { runId: actor.id ?? actor.actorId, status: actor.stateValue, version: c.version, output: c.output ?? null, error: c.error ?? null };
  }

  /** Run (or resume) a run; concurrent calls for the same run in this process share one executor. */
  function resume(runId) {
    if (running.has(runId)) return running.get(runId).then(() => resume(runId));
    const p = execute(runId).finally(() => running.delete(runId));
    running.set(runId, p);
    return p;
  }

  async function listRuns() {
    const out = [];
    for (let offset = 0; ; offset += 200) {
      const page = (await api('GET', `/v1/actors?definitionId=${RUN_DEFINITION_ID}&status=active&limit=200&offset=${offset}`)).actors ?? [];
      out.push(...page);
      if (page.length < 200) return out;
    }
  }

  return {
    /** Deploy the run definition (idempotent). */
    async setup() {
      try { await api('PUT', '/v1/definitions', { id: RUN_DEFINITION_ID, definition: RUN_DEFINITION }); }
      catch (err) { if (![400, 409].includes(err.status) || !/exist/i.test(err.body?.error ?? '')) throw err; }
    },

    /** Start a run on `version` (default: the last version listed for the workflow). Returns the run id. */
    async start(workflow, input = {}, { version, wait = true } = {}) {
      const versions = Object.keys(workflows[workflow] ?? {});
      if (!versions.length) throw new Error(`unknown workflow ${workflow}`);
      const v = version ?? versions[versions.length - 1];
      if (!workflows[workflow][v]) throw new Error(`unknown version ${workflow} ${v}`);
      const created = await api('POST', '/v1/actors', { definitionId: RUN_DEFINITION_ID, initialContext: { workflow, version: v, input: clone(input), stepCount: 0 } });
      const done = resume(created.id);
      if (wait) await done; else done.catch((e) => log(`[durable] ${created.id}: ${e.message}`));
      return created.id;
    },

    resume,

    /** Deliver a signal. It is stored first (durable), then the run is resumed. */
    async signal(runId, name, payload = null, { wait = true } = {}) {
      if (typeof name !== 'string' || FORBIDDEN.has(name)) throw new Error('bad signal name');
      await event(runId, 'SIGNAL', { [`inbox_${name}`]: { payload: clone(payload), at: Date.now() } });
      const p = resume(runId);
      return wait ? p : undefined;
    },

    /** Resume every unfinished run: after a crash or deploy, and to fire due timers. */
    async resumeAll() {
      const results = [];
      for (const a of await listRuns()) {
        const c = a.context ?? (await api('GET', `/v1/actors/${a.id}`)).context;
        if (!workflows[c.workflow]) continue;                   // another service's workflow
        if (a.stateValue === 'waiting' && c.waitingFor === '__timer' && c.wakeAt > Date.now()) continue;
        if (a.stateValue === 'waiting' && c.waitingFor && c.waitingFor !== '__timer' && c[`inbox_${c.waitingFor}`] == null && !releases.some((r) => r.workflow === c.workflow && r.from === c.version)) continue;
        try { results.push(await resume(a.id)); }
        catch (err) { log(`[durable] resume ${a.id}: ${err.message}`); results.push({ runId: a.id, status: 'error', error: err.message }); }
      }
      return results;
    },

    /** Dry run of a release over every unfinished run. Nothing changes. */
    async preview({ workflow, from, to, when, renameSteps }) {
      const fn = workflows[workflow]?.[to];
      if (!fn) throw new Error(`unknown version ${workflow} ${to}`);
      const out = { moves: [], stays: [], incompatible: [] };
      for (const a of await listRuns()) {
        const c = a.context ?? (await api('GET', `/v1/actors/${a.id}`)).context;
        if (c.workflow !== workflow || c.version !== from) continue;
        const journal = journalOf(c);
        const steps = journal.map((e) => renameSteps?.[e.name] ?? e.name);
        if (when && !(when.length === steps.length && when.every((n, i) => n === steps[i]))) { out.stays.push({ runId: a.id, steps }); continue; }
        const check = await replayCheck(fn, c.input, journal, renameSteps);
        (check.ok ? out.moves : out.incompatible).push({ runId: a.id, steps, ...(check.ok ? {} : { reason: check.reason }) });
      }
      return out;
    },

    /** Current status of a run. */
    async get(runId) {
      const a = await api('GET', `/v1/actors/${runId}`);
      return { ...summarize({ ...a, id: runId }), steps: journalOf(a.context).map((e) => `${e.kind}:${e.name}`), waitingFor: a.context.waitingFor ?? null };
    },
  };
}
