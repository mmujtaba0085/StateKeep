/**
 * Oracle for the workflow chaos simulation.
 *
 * Rebuilds every actor from its audit trail alone — spawn, each recorded event in
 * order, each MIGRATED marker — with StateKeep's own interpreter, but in memory,
 * without the database, caches, workers, network or processes that the faults hit.
 * If the live actor differs from the replay, something between the API and the
 * database lost, duplicated, reordered or misapplied work.
 *
 * It also checks the APV routing rules against the deployment log independently of
 * the engine: a migration must be justified by the deployment's historyPath, must not
 * go backwards or to another workflow, and an actor that matches a deployment must not
 * keep processing events on the old version.
 */
import { compileMachine } from '../../../src/runtime/definitionCompiler.js';
import { processEvent, computeInitialSnapshot, stateKeyOf } from '../../../src/runtime/interpreter.js';
import { withConditions } from '../../../src/runtime/conditionGuards.js';

const durableStub = Object.assign(() => {}, { __sk_durable: { delivery: 'at-most-once' } });
const REGISTRY = {
  guards: withConditions({ guards: {}, actions: {}, services: {} }).guards,
  actions: new Proxy({}, { get: (t, n) => (typeof n === 'string' && n !== 'then' ? durableStub : undefined) }),
  services: {},
};
const SPAWN_REGISTRY = withConditions({ guards: {}, actions: {}, services: {} });
const compiled = new Map();
const compile = (id, json) => { if (!compiled.has(id)) compiled.set(id, compileMachine(json)); return compiled.get(id); };

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canon = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => eq(canon(a), canon(b));

function getPath(o, p) { return p.split('.').reduce((c, k) => (c == null ? undefined : c[k]), o); }
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); let c = o; for (const k of ks) { if (typeof c[k] !== 'object' || c[k] === null) c[k] = {}; c = c[k]; } c[last] = v; }

/**
 * @param actor     live actor from GET /v1/actors/:id
 * @param trail     all events from GET /v1/actors/:id/events (ordered)
 * @param spawn     { definitionId, initialContext }
 * @param defs      Map definitionId → { json (as stored), deployedAt, parentId, workflow, historyPath, stateMapping, contextTransform, ackAt }
 * @param opts      { graceMs }
 */
export function replayActor({ actor, trail, spawn, defs, sentEids, graceMs = 1500 }) {
  const violations = [];
  const notes = { migrations: 0, timers: 0, followUps: 0, clientEvents: 0, transitions: [] };
  let defId = spawn.definitionId;
  let def = defs.get(defId);
  const snap = computeInitialSnapshot(compile(defId, def.json), def.json, spawn.initialContext, SPAWN_REGISTRY);
  let entry = { stateValue: snap.stateValue, context: snap.context, historyFingerprint: snap.historyFingerprint ?? '0', stateEntryId: 0 };
  const history = [];               // event types that caused a transition (the APV fingerprint input)
  let done = !!snap.done;
  const seenEids = new Map();
  let enteredAt = trail.find((e) => e.type === 'SPAWN')?.processedAt ?? 0;

  for (const ev of trail) {
    if (ev.type === 'SPAWN' || ev.type === 'SCHEDULED_EVENT_FIRED') continue;
    if (ev.type === 'MIGRATION_FAILED') {                 // parked for rescue on the target version
      violations.push(`migration to ${ev.payload?.toDefinitionId} failed (${ev.payload?.reason}) for state ${JSON.stringify(ev.payload?.stateValue)}`);
      if (defs.get(ev.payload?.toDefinitionId)) { defId = ev.payload.toDefinitionId; def = defs.get(defId); }
      continue;
    }
    if (ev.type === 'MIGRATED') {
      notes.migrations++;
      const p = ev.payload ?? {};
      const target = defs.get(p.toDefinitionId);
      if (p.fromDefinitionId !== defId) violations.push(`MIGRATED from ${p.fromDefinitionId} but the replay is on ${defId}`);
      if (!same(p.fromState, entry.stateValue)) {
        violations.push(`migration used a stale state: it moved ${JSON.stringify(p.fromState)} but the actor was in ${JSON.stringify(entry.stateValue)} (an event was overwritten)`);
      }
      if (!target) { violations.push(`MIGRATED to unknown definition ${p.toDefinitionId}`); break; }
      // routing rules
      if (target.workflow !== def.workflow) violations.push(`migrated across workflows: ${defId} → ${p.toDefinitionId}`);
      if (Number(target.deployedAt) <= Number(def.deployedAt)) violations.push(`migrated backwards: ${defId} → ${p.toDefinitionId}`);
      if (target.historyPath && !eq(history, target.historyPath)) {
        violations.push(`unjustified migration to ${p.toDefinitionId}: its historyPath is ${JSON.stringify(target.historyPath)} but the actor's history was ${JSON.stringify(history)}`);
      }
      // state mapping (checked for simple top-level states)
      if (typeof p.fromState === 'string' && typeof p.toState === 'string') {
        const expected = target.stateMapping?.[p.fromState] ?? p.fromState;
        if (expected !== p.toState) violations.push(`state mapped ${p.fromState} → ${p.toState}, expected ${expected}`);
      }
      const ctx = JSON.parse(JSON.stringify(entry.context ?? {}));
      for (const [to, from] of Object.entries(target.contextTransform ?? {})) {
        const v = getPath(entry.context ?? {}, from);
        if (v !== undefined) setPath(ctx, to, v);
      }
      entry = { ...entry, stateValue: p.toState, context: ctx };
      defId = p.toDefinitionId; def = target;
      enteredAt = ev.processedAt;
      continue;
    }
    // an event the actor processed
    if (done) { violations.push(`event ${ev.type} recorded after the actor finished`); continue; }
    const payload = ev.payload ?? {};
    if (payload._eid) {
      seenEids.set(payload._eid, (seenEids.get(payload._eid) ?? 0) + 1);
      notes.clientEvents++;
    }
    if (payload._job) notes.followUps++;
    if (ev.type.startsWith('__SK_TIMEOUT_')) notes.timers++;

    // APV: before this event, must the actor have moved to a newer version?
    for (const [cid, d] of defs) {
      if (d.parentId !== defId || d.workflow !== def.workflow) continue;
      if (ev.processedAt <= d.ackAt + graceMs) continue;
      // An actor pinned to a version after a newer one was deployed is, by design, not
      // moved by it: only deployments that began after its spawn apply to it.
      if (spawn.pinned && !(d.startAt > spawn.ackAt)) continue;
      const matches = d.historyPath ? eq(history, d.historyPath) : true;
      if (matches) {
        const mappable = typeof entry.stateValue !== 'string' || d.json.states?.[d.stateMapping?.[entry.stateValue] ?? entry.stateValue];
        if (mappable) violations.push(`missed migration: processed ${ev.type} on ${defId} ${ev.processedAt - d.ackAt}ms after ${cid} was deployed ${d.historyPath ? `for history ${JSON.stringify(d.historyPath)}` : '(all actors)'}`);
      }
    }

    const prevEnteredAt = enteredAt;
    const isSystem = ev.type.startsWith('__SK_');
    let e = entry;
    if (!isSystem && Object.keys(payload).length) e = { ...entry, context: { ...entry.context, ...payload } };
    const r = processEvent(e, compile(defId, def.json), { ...payload, type: ev.type }, REGISTRY, []);
    if (r.error) { violations.push(`replay error ${r.error} at ${ev.type}`); break; }
    if (r.historyFingerprint !== e.historyFingerprint) {
      history.push(ev.type);
      notes.transitions.push(ev.type);
      enteredAt = ev.processedAt;
      // a timer that fired before its delay had passed since the state was entered
    }
    if (ev.type.startsWith('__SK_TIMEOUT_')) {
      const ms = Number(ev.type.split('_').pop());
      if (Number.isFinite(ms) && ev.processedAt < prevEnteredAt + ms - 250) violations.push(`timer ${ev.type} fired ${prevEnteredAt + ms - ev.processedAt}ms early`);
    }
    entry = { stateValue: r.stateValue, context: r.context ?? e.context, historyFingerprint: r.historyFingerprint, stateEntryId: 0 };
    if (r.done) done = true;
  }

  // the live actor must equal the replay
  if (actor.definitionId !== defId) violations.push(`live actor is on ${actor.definitionId}, replay ends on ${defId}`);
  if (!same(actor.stateValue, entry.stateValue)) violations.push(`live state ${JSON.stringify(actor.stateValue)} ≠ replayed ${JSON.stringify(entry.stateValue)}`);
  if (!same(actor.context, entry.context)) {
    const keys = new Set([...Object.keys(actor.context ?? {}), ...Object.keys(entry.context ?? {})]);
    const diff = [...keys].filter((k) => !same(actor.context?.[k], entry.context?.[k])).map((k) => `${k}: live ${JSON.stringify(actor.context?.[k])} vs replay ${JSON.stringify(entry.context?.[k])}`);
    violations.push(`live context differs from replay (${diff.slice(0, 3).join('; ')})`);
  }
  // every acknowledged client event exactly once
  for (const eid of sentEids.acked) {
    const n = seenEids.get(eid) ?? 0;
    if (n !== 1) violations.push(`acknowledged event ${eid} appears ${n}× in the history`);
  }
  for (const [eid, n] of seenEids) if (n > 1) violations.push(`event ${eid} recorded ${n}×`);
  // a state with a timer must not be sat in long after the timer should have fired
  if (!done) {
    const afters = compile(defId, def.json).afterTransitions?.[stateKeyOf(entry.stateValue)] ?? [];
    const due = afters.length ? enteredAt + Math.max(...afters.map((a) => a.delayMs)) : null;
    if (due && Date.now() > due + 12_000) violations.push(`timer never fired: in ${stateKeyOf(entry.stateValue)} since ${Math.round((Date.now() - enteredAt) / 1000)}s, timer due after ${Math.max(...afters.map((a) => a.delayMs))}ms`);
  }
  return { violations, notes, replayed: { definitionId: defId, stateValue: entry.stateValue }, history };
}
