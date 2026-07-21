// src/runtime/definitionCompiler.js
//
// Compile a raw XState v5 definition JSON into a flat runtime form.
// XState itself is NOT imported here — compilation is pure JSON walking.
// Mutates a deep-cloned copy (runtimeDef) for after: transformation.

/**
 * Resolve a transition target to an absolute state-key path.
 *
 * XState v5 bare-identifier targets are sibling references: they resolve
 * against the parent of the state that DEFINES the transition.
 *   - '' (null/undefined) → null (internal/forbidden)
 *   - starts with '#'     → absolute ID — strip machine-id prefix
 *   - contains '.'        → already absolute (dot-separated path), keep as-is
 *   - otherwise           → sibling: parentKey ? `${parentKey}.${t}` : t
 *
 * @param {string|null} target
 * @param {string}      parentKey   dot-path of the parent of the defining state ('' at root)
 */
function resolveTarget(target, parentKey) {
  if (!target) return null;
  if (target.startsWith('#')) {
    // '#machineId.a.b' → 'a.b'
    const dot = target.indexOf('.');
    return dot >= 0 ? target.slice(dot + 1) : target;
  }
  if (target.includes('.')) return target;  // already absolute
  return parentKey ? `${parentKey}.${target}` : target;
}

/**
 * Normalise a transition config to an array of candidates.
 * Each candidate: { target, guard, actions }
 * Targets are resolved to absolute state-key paths using resolveTarget().
 */
function normaliseCandidates(config, parentKey = '') {
  if (!config) return [];
  const arr = Array.isArray(config) ? config : [config];
  return arr.map(c => {
    if (typeof c === 'string') return { target: resolveTarget(c, parentKey), guard: null, actions: [] };
    return {
      target:  resolveTarget(c.target ?? null, parentKey),
      guard:   c.guard  ?? null,
      actions: normaliseActions(c.actions),
    };
  });
}

function normaliseActions(a) {
  if (!a) return [];
  return (Array.isArray(a) ? a : [a]).map(x => (typeof x === 'string' ? x : x?.type ?? String(x)));
}

/**
 * Walk a states map recursively, collecting compiled artefacts.
 * parentKey: dot-separated path to parent state ('' for root states)
 * stateNode in runtimeDef: direct reference for mutation (after: removal).
 */
function walkStates(statesMap, runtimeStatesMap, parentKey, acc) {
  for (const [name, cfg] of Object.entries(statesMap ?? {})) {
    const key   = parentKey ? `${parentKey}.${name}` : name;
    const rtCfg = runtimeStatesMap[name];

    // Final state
    if (cfg.type === 'final') acc.finalStates.push(key);

    // Parallel region group
    if (cfg.type === 'parallel' && cfg.states) {
      const children = Object.keys(cfg.states).map(c => `${key}.${c}`);
      acc.parallelStates.push(key);   // Bug #2: always record parallel state keys for interpreter detection
      const onDone   = cfg.onDone;
      if (onDone) {
        const rawTarget = typeof onDone === 'string' ? onDone : onDone.target;
        acc.parallelGroups.push({ parent: key, children, onDone: resolveTarget(rawTarget, parentKey) });
      }
    }

    // after: → __SK_TIMEOUT_ transformation
    if (cfg.after) {
      // Normalise all three XState v5 after: forms into an array of { delay, target }:
      //   Map form:    { 500: 'next' } or { 500: { target, guard, actions } }
      //   Array form:  [{ delay: 500, target: 'next' }]
      //   Object form: { delay: 500, target: 'next' }
      let afters;
      if (Array.isArray(cfg.after)) {
        afters = cfg.after;
      } else if (typeof cfg.after === 'object' && !('delay' in cfg.after) && !('target' in cfg.after)) {
        afters = Object.entries(cfg.after).map(([delayStr, val]) => {
          const delay = Number(delayStr);
          if (typeof val === 'string') return { delay, target: val };
          return { delay, target: val.target ?? null, guard: val.guard ?? null, actions: val.actions ?? [] };
        });
      } else {
        afters = [cfg.after];
      }

      acc.afterTransitions[key] = [];
      rtCfg.on = rtCfg.on ?? {};
      for (const entry of afters) {
        const delayMs = typeof entry === 'number' ? entry
          : typeof entry.delay === 'number' ? entry.delay
          : parseInt(entry.delay, 10);
        const target   = typeof entry === 'string' ? entry : entry.target;
        const safeKey  = key.replace(/\./g, '_');
        const eventType = `__SK_TIMEOUT_${safeKey}_${delayMs}`;
        acc.afterTransitions[key].push({ delayMs, eventType });
        rtCfg.on[eventType] = target;
        acc.transitions[`${key}:${eventType}`] = [{ target: resolveTarget(target, parentKey), guard: null, actions: [] }];
      }
      delete rtCfg.after;
    }

    // Regular on: transitions
    for (const [evType, transConfig] of Object.entries(cfg.on ?? {})) {
      acc.transitions[`${key}:${evType}`] = normaliseCandidates(transConfig, parentKey);
    }

    // always: (transient)
    if (cfg.always) {
      acc.transientStates[key] = normaliseCandidates(cfg.always, parentKey);
    }

    // Invoke: states with invoke: [...] field
    if (cfg.invoke) {
      const invokes = Array.isArray(cfg.invoke) ? cfg.invoke : [cfg.invoke];
      acc.invokeStates = acc.invokeStates ?? {};
      acc.invokeStates[key] = invokes.map(inv => ({
        id:  inv.id ?? inv.src,
        src: inv.src ?? inv.id,
      }));
      // Bug #4: compile onDone/onError so done.invoke.* / error.invoke.* events are routable
      for (const inv of invokes) {
        const invokeId = inv.id ?? inv.src;
        if (inv.onDone) {
          const doneEvent = `done.invoke.${invokeId}`;
          acc.transitions[`${key}:${doneEvent}`] = normaliseCandidates(
            typeof inv.onDone === 'string'
              ? { target: inv.onDone, actions: [], guard: null }
              : { target: inv.onDone.target ?? null, actions: inv.onDone.actions ?? [], guard: inv.onDone.cond ?? null },
            parentKey
          );
        }
        if (inv.onError) {
          const errEvent = `error.invoke.${invokeId}`;
          acc.transitions[`${key}:${errEvent}`] = normaliseCandidates(
            typeof inv.onError === 'string'
              ? { target: inv.onError, actions: [], guard: null }
              : { target: inv.onError.target ?? null, actions: inv.onError.actions ?? [], guard: inv.onError.cond ?? null },
            parentKey
          );
        }
      }
    }

    // Entry/exit actions
    if (cfg.entry) acc.entryActions[key] = normaliseActions(cfg.entry);
    if (cfg.exit)  acc.exitActions[key]  = normaliseActions(cfg.exit);

    // Recurse
    if (cfg.states) {
      // Bug #1A: record initial child for compound (non-parallel) states
      if (cfg.type !== 'parallel') {
        const childName = cfg.initial ?? Object.keys(cfg.states)[0];
        acc.compoundInitials[key] = `${key}.${childName}`;
      }
      walkStates(cfg.states, rtCfg.states ?? {}, key, acc);
    }
  }
}

/**
 * Compile a StateKeep/XState machine definition JSON.
 *
 * Returns:
 *  transitions:     { 'stateKey:EventType': [{ target, guard, actions }] }
 *  afterTransitions:{ 'stateKey': [{ delayMs, eventType }] }
 *  entryActions:    { 'stateKey': ['actionName', ...] }
 *  exitActions:     { 'stateKey': ['actionName', ...] }
 *  transientStates: { 'stateKey': [{ target, guard, actions }] }
 *  parallelGroups:  [{ parent, children, onDone }]
 *  finalStates:     ['stateKey', ...]
 *  runtimeDef:      deep-cloned definition with after: removed, __SK_TIMEOUT_ injected
 */
export function compileMachine(definition) {
  const runtimeDef = JSON.parse(JSON.stringify(definition));
  const acc = {
    transitions:      {},
    afterTransitions: {},
    entryActions:     {},
    exitActions:      {},
    transientStates:  {},
    parallelGroups:   [],
    parallelStates:   [],  // Bug #2: all parallel state keys (for interpreter detection)
    finalStates:      [],
    invokeStates:     {},
    compoundInitials: {},  // Bug #1A: stateKey → initial-child stateKey for compound states
  };

  walkStates(definition.states ?? {}, runtimeDef.states ?? {}, '', acc);

  return { ...acc, runtimeDef };
}
