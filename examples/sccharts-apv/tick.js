/**
 * tick.js — synchronous reactions for the SCCharts subset of sctx.js.
 *
 * An instance reacts in discrete ticks. In each tick, given the set of present inputs:
 *   - for every active state, outermost first: an enabled `abort` (strong preemption)
 *     is taken before its inner behaviour runs; otherwise its regions react, and then an
 *     enabled `go` (weak abort) or `join` (all regions final) is taken;
 *   - a transition that is not `immediate` is enabled only if its source was entered in
 *     an earlier tick; `immediate` transitions are also checked when a state is entered
 *     (bounded: an instantaneous loop is an error);
 *   - transitions of one state are tried in declaration order;
 *   - entry, during and exit actions set boolean outputs; pure signal outputs are reset
 *     at the start of every tick; exit actions are skipped under a strong abort.
 *
 * This is a deliberately small semantics: no valued variables, no causality analysis,
 * no sequential constructiveness for shared variables. It is enough to study versioning,
 * which is what this prototype is for. The key property it relies on is that between two
 * ticks an instance is quiescent: that is where a new version can be applied.
 *
 * The instance records every transition it takes (`history`, transition ids), in a fixed
 * order within a tick (outer before inner, regions in declaration order), so the history
 * is deterministic for a given input sequence.
 */

const MAX_IMMEDIATE = 64;

export function initialConfiguration(chart, inst) {
  inst.active = new Set();
  inst.enteredAt = new Map();
  inst.outputs = Object.fromEntries(Object.entries(chart.outputs).map(([k, o]) => [k, o.init ?? false]));
  enterRegions(chart, chart.root, inst, 0, new Set(), 0);
}

function stateOf(chart, path) { return path === '' ? chart.root : chart.states.get(path); }
function activeChild(region, inst) { return region.states.find((s) => inst.active.has(s.path)); }

function applyEffects(effects, inst) { for (const e of effects) inst.outputs[e.out] = e.v; }

function enter(chart, s, inst, tick, present, depth) {
  inst.active.add(s.path);
  inst.enteredAt.set(s.path, tick);
  applyEffects(s.entry, inst);
  enterRegions(chart, s, inst, tick, present, depth);
  // immediate transitions of the state just entered
  for (const t of s.transitions) {
    if (t.immediate && t.kind !== 'join' && t.trigger(present)) {
      if (depth > MAX_IMMEDIATE) throw new Error(`instantaneous loop at ${s.path}`);
      take(chart, t, inst, tick, present, false, depth + 1);
      return;
    }
  }
}

function enterRegions(chart, s, inst, tick, present, depth) {
  for (const r of s.regions) {
    const init = r.states.find((x) => x.initial);
    enter(chart, init, inst, tick, present, depth);
  }
}

function exit(chart, s, inst, runExitActions) {
  for (const r of s.regions) {
    const c = activeChild(r, inst);
    if (c) exit(chart, c, inst, runExitActions);
  }
  if (runExitActions) applyEffects(s.exit, inst);
  inst.active.delete(s.path);
}

function take(chart, t, inst, tick, present, strong, depth) {
  const src = stateOf(chart, t.source), tgt = stateOf(chart, t.target);
  exit(chart, src, inst, !strong);
  applyEffects(t.effects, inst);
  inst.history.push(t.id);
  enter(chart, tgt, inst, tick, present, depth);
}

const enabled = (t, s, inst, tick, present) =>
  (t.immediate || inst.enteredAt.get(s.path) < tick) && t.trigger(present);

function allFinal(s, inst) {
  return s.regions.every((r) => { const c = activeChild(r, inst); return c && c.final; });
}

/** React one active state (and, inside it, its regions). Returns true if it was left. */
function reactState(chart, s, inst, tick, present) {
  for (const t of s.transitions) {
    if (t.kind === 'abort' && enabled(t, s, inst, tick, present)) { take(chart, t, inst, tick, present, true, 0); return true; }
  }
  for (const r of s.regions) {
    const c = activeChild(r, inst);
    if (c) reactState(chart, c, inst, tick, present);
  }
  for (const t of s.transitions) {
    if (t.kind === 'go' && enabled(t, s, inst, tick, present)) { take(chart, t, inst, tick, present, false, 0); return true; }
    if (t.kind === 'join' && (t.immediate || inst.enteredAt.get(s.path) < tick) && allFinal(s, inst) && t.trigger(present)) {
      take(chart, t, inst, tick, present, false, 0); return true;
    }
  }
  if (inst.enteredAt.get(s.path) < tick) applyEffects(s.during, inst);
  return false;
}

/** One tick of an instance; `present` is the set (or array) of present input names. */
export function react(chart, inst, present) {
  const p = present instanceof Set ? present : new Set(present);
  for (const [k, o] of Object.entries(chart.outputs)) if (o.type === 'signal') inst.outputs[k] = false;
  inst.tick += 1;
  for (const r of chart.root.regions) {
    const c = activeChild(r, inst);
    if (c) reactState(chart, c, inst, inst.tick, p);
  }
  const top = chart.root.regions[0].states.find((x) => inst.active.has(x.path));
  if (top?.final) inst.status = 'finished';
}

/** Active leaf states (the configuration as leaves, one per active region). */
export function activeLeaves(chart, inst) {
  return [...inst.active].filter((p) => stateOf(chart, p)?.regions.length === 0).sort();
}
