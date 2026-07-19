// src/runtime/definitionCompiler.js
//
// Compile a raw XState v5 definition JSON into a flat runtime form.
// XState itself is NOT imported here — compilation is pure JSON walking.
// Mutates a deep-cloned copy (runtimeDef) for after: transformation.

/**
 * Normalise a transition config to an array of candidates.
 * Each candidate: { target, guard, actions }
 */
function normaliseCandidates(config) {
  if (!config) return [];
  const arr = Array.isArray(config) ? config : [config];
  return arr.map(c => {
    if (typeof c === 'string') return { target: c, guard: null, actions: [] };
    return {
      target:  c.target ?? null,
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
      const onDone   = cfg.onDone;
      if (onDone) {
        const target = typeof onDone === 'string' ? onDone : onDone.target;
        acc.parallelGroups.push({ parent: key, children, onDone: target });
      }
    }

    // after: → __SK_TIMEOUT_ transformation
    if (cfg.after) {
      const afters = Array.isArray(cfg.after) ? cfg.after : [cfg.after];
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
        acc.transitions[`${key}:${eventType}`] = [{ target, guard: null, actions: [] }];
      }
      delete rtCfg.after;
    }

    // Regular on: transitions
    for (const [evType, transConfig] of Object.entries(cfg.on ?? {})) {
      acc.transitions[`${key}:${evType}`] = normaliseCandidates(transConfig);
    }

    // always: (transient)
    if (cfg.always) {
      acc.transientStates[key] = normaliseCandidates(cfg.always);
    }

    // Invoke: states with invoke: [...] field
    if (cfg.invoke) {
      const invokes = Array.isArray(cfg.invoke) ? cfg.invoke : [cfg.invoke];
      acc.invokeStates = acc.invokeStates ?? {};
      acc.invokeStates[key] = invokes.map(inv => ({
        id:  inv.id ?? inv.src,
        src: inv.src ?? inv.id,
      }));
    }

    // Entry/exit actions
    if (cfg.entry) acc.entryActions[key] = normaliseActions(cfg.entry);
    if (cfg.exit)  acc.exitActions[key]  = normaliseActions(cfg.exit);

    // Recurse
    if (cfg.states) {
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
    finalStates:      [],
    invokeStates:     {},
  };

  walkStates(definition.states ?? {}, runtimeDef.states ?? {}, '', acc);

  return { ...acc, runtimeDef };
}
