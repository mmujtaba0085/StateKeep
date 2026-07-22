// src/runtime/interpreter.js
//
// Main-thread event processor. Replaces XState on the EVENT hot path.
// No XState import. No async I/O. Returns synchronously.
// Async side-effects (tier2Actions, durableActions, scheduledEventOps) are
// returned as data — callers execute them after state is committed.

import { randomInt }         from 'crypto';
import { updateFingerprint } from '../ffi/fingerprintChain.js';

// Guards against infinite always-guard cycles in user-defined machines (e.g. A→B guard, B→A guard, repeat)
const MAX_TRANSIENT_DEPTH = 100;

// Deduplicate missing-guard warnings (avoid log flood at 30k ev/s)
const _warnedGuards = new Set();

// ── State key helpers ─────────────────────────────────────────────────────────

/** Extract the canonical string key from a stateValue (flat or compound). */
export function stateKeyOf(stateValue) {
  if (typeof stateValue === 'string') return stateValue;
  if (stateValue && typeof stateValue === 'object') {
    // Compound: { flow: 'step1' } → 'flow.step1'
    const top = Object.keys(stateValue)[0];
    const sub = stateValue[top];
    if (typeof sub === 'string') return `${top}.${sub}`;
    if (sub && typeof sub === 'object') {
      // Deeper nesting: recurse
      return `${top}.${stateKeyOf(sub)}`;
    }
    return top;
  }
  return String(stateValue);
}

/** Build stateValue object from a dot-separated key. 'flow.step1' → { flow: 'step1' } */
export function keyToStateValue(key) {
  const parts = key.split('.');
  if (parts.length === 1) return key;
  // Build nested object: ['flow', 'step1'] → { flow: 'step1' }
  let result = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) {
    result = { [parts[i]]: result };
  }
  return result;
}

// ── Transition lookup with hierarchical bubbling ──────────────────────────────

function findCandidates(stateKey, eventType, transitions) {
  // Exact match first
  const exact = transitions[`${stateKey}:${eventType}`];
  if (exact) return exact;
  // Bubble up through parent states
  // XState v5 semantics: events propagate leaf→root; a transition on a parent handles all its children
  const parts = stateKey.split('.');
  while (parts.length > 1) {
    parts.pop();
    const parent = parts.join('.');
    const found = transitions[`${parent}:${eventType}`];
    if (found) return found;
  }
  return null;
}

// ── Guard evaluation ──────────────────────────────────────────────────────────

function evalGuard(guardName, context, event, registry) {
  if (!guardName) return true;
  const fn = registry.guards[guardName];
  if (!fn) {
    if (!_warnedGuards.has(guardName)) {
      _warnedGuards.add(guardName);
      console.warn(`[interpreter] Guard '${guardName}' not found in registry — treating as false`);
    }
    return false;
  }
  try {
    return Boolean(fn({ context, event }, {}));
  } catch (err) {
    console.error(`[interpreter] Guard '${guardName}' threw:`, err.message);
    return false;
  }
}

// ── Action classification ─────────────────────────────────────────────────────

function classifyAction(name, registry) {
  const fn = registry.actions[name];
  if (!fn) return null;
  if (fn.__sk_durable) return { type: 'durable', name, fn };
  if (fn.constructor?.name === 'AsyncFunction') return { type: 'tier2', name, fn };
  return { type: 'tier1', name, fn };
}

// ── computeInitialSnapshot ────────────────────────────────────────────────────

/**
 * computeInitialSnapshot — SPAWN semantics.
 * Runs entry actions for the initial state, chases always-transitions.
 * HYDRATE must NOT call this — use restoreSnapshot (no entry actions).
 */
export function computeInitialSnapshot(compiledJson, definitionJson, initialContext, registry) {
  const {
    entryActions    = {},
    exitActions     = {},
    transientStates = {},
    afterTransitions = {},
    finalStates     = [],
    compoundInitials = {},
    invokeStates    = {},
    parallelStates  = [],
  } = compiledJson;
  const reg    = registry ?? { guards: {}, actions: {}, services: {} };
  const synevt = { type: 'SPAWN' };
  const meta   = { actorId: null, send: () => {}, raise: () => {}, emit: () => {} };
  const initial = definitionJson.initial;
  if (!initial) return { error: 'INVALID_INITIAL_STATE' };

  let context = { ...(initialContext ?? {}) };
  const tier2 = [], durable = [], schedOps = [];

  const fireEntry = (key) => {
    for (const name of (entryActions[key] ?? [])) {
      const cl = classifyAction(name, reg);
      if (!cl) continue;
      if (cl.type === 'tier1') {
        try {
          const r = cl.fn({ context, event: synevt }, meta);
          if (r && typeof r === 'object' && !r.then) context = { ...context, ...r };
        } catch {}
      } else if (cl.type === 'tier2') {
        tier2.push({ name, fn: cl.fn, context, event: synevt });
      } else if (cl.type === 'durable') {
        durable.push({ name, fn: cl.fn, context, event: synevt, opts: cl.fn.__sk_durable });
      }
    }
  };

  // Descend compound initial states to the leaf, firing entry actions en route
  const descendToLeaf = (key) => {
    let cur = key;
    while (compoundInitials[cur]) {
      fireEntry(cur);
      if (afterTransitions[cur])
        schedOps.push({ op: 'create', stateKey: cur, newEntryId: null, entries: afterTransitions[cur] });
      cur = compoundInitials[cur];
    }
    return cur;
  };

  // Chase always (transient) transitions from a leaf, running exit/entry actions
  const chaseTransients = (startKey) => {
    let cur = startKey, depth = 0;
    while (transientStates[cur] && depth < MAX_TRANSIENT_DEPTH) {
      depth++;
      const candidates = transientStates[cur];
      let winner = null;
      for (const c of candidates) {
        if (evalGuard(c.guard, context, synevt, reg)) { winner = c; break; }
      }
      if (!winner) break;
      for (const name of (exitActions[cur] ?? [])) {
        const cl = classifyAction(name, reg);
        if (!cl) continue;
        if (cl.type === 'tier1') {
          try {
            const r = cl.fn({ context, event: synevt }, meta);
            if (r && typeof r === 'object' && !r.then) context = { ...context, ...r };
          } catch {}
        } else if (cl.type === 'tier2') {
          tier2.push({ name, fn: cl.fn, context, event: synevt });
        } else if (cl.type === 'durable') {
          durable.push({ name, fn: cl.fn, context, event: synevt, opts: cl.fn.__sk_durable });
        }
      }
      cur = winner.target ?? cur;
      fireEntry(cur);
    }
    if (depth >= MAX_TRANSIENT_DEPTH && transientStates[cur]) return { error: 'TRANSIENT_LOOP_DETECTED' };
    return { leafKey: cur };
  };

  let finalStateValue, finalStateKey;

  if (parallelStates.includes(String(initial))) {
    // Parallel initial: fan out all regions to their initial leaves
    const parallelRoot = String(initial);
    const regionDefs   = definitionJson.states?.[parallelRoot]?.states ?? {};
    const regionValues = {};
    fireEntry(parallelRoot);
    if (afterTransitions[parallelRoot])
      schedOps.push({ op: 'create', stateKey: parallelRoot, newEntryId: null, entries: afterTransitions[parallelRoot] });
    for (const [rName, rDef] of Object.entries(regionDefs)) {
      const rInitial = rDef.initial;
      if (!rInitial) return { error: 'INVALID_INITIAL_STATE' };
      const rKey    = `${parallelRoot}.${rName}.${rInitial}`;
      const leafKey = descendToLeaf(rKey);
      const tr      = chaseTransients(leafKey);
      if (tr.error) return tr;
      const finalLeaf = tr.leafKey;
      fireEntry(finalLeaf);
      const prefix    = `${parallelRoot}.${rName}.`;
      const leafAfter = finalLeaf.startsWith(prefix) ? finalLeaf.slice(prefix.length) : finalLeaf;
      regionValues[rName] = keyToStateValue(leafAfter);
    }
    finalStateValue = { [parallelRoot]: regionValues };
    finalStateKey   = parallelRoot;
  } else {
    const leafKey = descendToLeaf(String(initial));
    const tr      = chaseTransients(leafKey);
    if (tr.error) return tr;
    const finalLeaf = tr.leafKey;
    fireEntry(finalLeaf);
    finalStateValue = keyToStateValue(finalLeaf);
    finalStateKey   = finalLeaf;
  }

  const stateEntryId = randomInt(0, 2 ** 32);
  if (afterTransitions[finalStateKey])
    schedOps.push({ op: 'create', stateKey: finalStateKey, newEntryId: stateEntryId, entries: afterTransitions[finalStateKey] });
  for (const op of schedOps) { if (op.newEntryId === null) op.newEntryId = stateEntryId; }

  const done = Array.isArray(finalStates) && finalStates.includes(finalStateKey);

  return {
    stateValue:         finalStateValue,
    context,
    historyFingerprint: '0',
    stateEntryId,
    done,
    scheduledEventOps:  schedOps,
    tier2Actions:       tier2,
    durableActions:     durable,
    invokesToStart:     (invokeStates[finalStateKey] ?? []).map(inv => ({
      id: inv.id ?? inv.src, src: inv.src ?? inv.id,
    })),
  };
}

// ── Full parallel-region dispatch ─────────────────────────────────────────────

function _processParallelEvent(
  entry, compiledJson, event, registry, pendingSends,
  parallelRoot, parallelRegions, tier2, durable, schedOps, context
) {
  const { transitions, transientStates, entryActions, exitActions, afterTransitions,
          finalStates, parallelGroups } = compiledJson;
  const meta = {
    actorId: entry.actorId,
    send:  (targetId, ev) => pendingSends.push({ targetId, event: ev }),
    raise: (ev)           => pendingSends.push({ targetId: entry.actorId, event: ev }),
    emit:  () => {},
  };

  // regionFullKeys: full region path → full leaf state key
  // e.g. 'root.A' → 'root.A.a1'  — matches parallelGroups.children format
  const newRegionMap   = {};
  const regionFullKeys = {};

  for (const [regionName, regionStateVal] of Object.entries(parallelRegions)) {
    const leafStr        = typeof regionStateVal === 'string' ? regionStateVal : stateKeyOf(regionStateVal);
    const regionStateKey = `${parallelRoot}.${regionName}.${leafStr}`;
    const fullRegionPath = `${parallelRoot}.${regionName}`;

    newRegionMap[regionName]       = regionStateVal;
    regionFullKeys[fullRegionPath] = regionStateKey;

    const isKnownFinal = finalStates?.includes(regionStateKey);
    if (isKnownFinal) continue;

    const hasKnown = transitions && Object.keys(transitions).some(k => k.startsWith(`${regionStateKey}:`));
    if (!hasKnown) {
      console.warn(
        `[interpreter] parallel region "${regionName}" in unknown state "${regionStateKey}" ` +
        `— stateValue may be corrupted (actorId: ${entry.actorId})`
      );
      continue;
    }

    const candidates = findCandidates(regionStateKey, event.type, transitions);
    if (!candidates) continue;

    let winner = null;
    for (const c of candidates) {
      if (evalGuard(c.guard, context, event, registry)) { winner = c; break; }
    }
    if (!winner) continue;

    for (const name of (exitActions[regionStateKey] ?? [])) {
      const cl = classifyAction(name, registry);
      if (!cl) continue;
      if (cl.type === 'tier1') {
        try { const r = cl.fn({ context, event }, meta); if (r && typeof r === 'object' && !r.then) context = { ...context, ...r }; } catch {}
      } else if (cl.type === 'tier2') tier2.push({ name, fn: cl.fn, context, event });
      else if (cl.type === 'durable') durable.push({ name, fn: cl.fn, context, event, opts: cl.fn.__sk_durable });
    }

    for (const name of (winner.actions ?? [])) {
      const cl = classifyAction(name, registry);
      if (!cl) continue;
      if (cl.type === 'tier1') {
        try { const r = cl.fn({ context, event }, meta); if (r && typeof r === 'object' && !r.then) context = { ...context, ...r }; } catch (err) { console.error(`[interpreter] Tier-1 action '${name}' threw:`, err.message); }
      } else if (cl.type === 'tier2') tier2.push({ name, fn: cl.fn, context, event });
      else if (cl.type === 'durable') durable.push({ name, fn: cl.fn, context, event, opts: cl.fn.__sk_durable });
    }

    // Chase transients within the region
    let newRegionStateKey = winner.target ?? regionStateKey;
    let td = 0;
    while (transientStates?.[newRegionStateKey] && td < MAX_TRANSIENT_DEPTH) {
      td++;
      const ts = transientStates[newRegionStateKey];
      let tw = null;
      for (const t of ts) { if (evalGuard(t.guard, context, event, registry)) { tw = t; break; } }
      if (!tw) break;
      newRegionStateKey = tw.target ?? newRegionStateKey;
    }

    for (const name of (entryActions[newRegionStateKey] ?? [])) {
      const cl = classifyAction(name, registry);
      if (!cl) continue;
      if (cl.type === 'tier1') {
        try { const r = cl.fn({ context, event }, meta); if (r && typeof r === 'object' && !r.then) context = { ...context, ...r }; } catch {}
      } else if (cl.type === 'tier2') tier2.push({ name, fn: cl.fn, context, event });
      else if (cl.type === 'durable') durable.push({ name, fn: cl.fn, context, event, opts: cl.fn.__sk_durable });
    }

    const newLeaf = newRegionStateKey.slice(`${parallelRoot}.${regionName}.`.length);
    newRegionMap[regionName]       = keyToStateValue(newLeaf) ?? newLeaf;
    regionFullKeys[fullRegionPath] = newRegionStateKey;

    if (afterTransitions?.[regionStateKey])
      schedOps.push({ op: 'cancel', stateKey: regionStateKey });
    if (afterTransitions?.[newRegionStateKey]) {
      const rEntryId = randomInt(0, 2 ** 32);
      schedOps.push({ op: 'create', stateKey: newRegionStateKey, newEntryId: rEntryId,
                      entries: afterTransitions[newRegionStateKey] });
    }
  }

  // isDone: all regions in final states; onDone triggers transition out of parallel
  const group = parallelGroups?.find(g => g.parent === parallelRoot);
  let returnStateValue = { [parallelRoot]: newRegionMap };
  let isDone = false;

  if (group) {
    // Parallel state has an onDone handler — use compiler-recorded children list
    const allDone = group.children.every(childPath => {
      const fullKey = regionFullKeys[childPath];
      return fullKey != null && (finalStates?.includes(fullKey) ?? false);
    });
    if (allDone && group.onDone) {
      returnStateValue = keyToStateValue(group.onDone);
      isDone           = finalStates?.includes(group.onDone) ?? false;
    } else {
      isDone = allDone;
    }
  } else {
    // No onDone: done when every region's current state is a final state
    isDone = Object.values(regionFullKeys).every(
      fullKey => fullKey != null && (finalStates?.includes(fullKey) ?? false)
    );
  }

  const newFingerprint = updateFingerprint(entry.historyFingerprint, event.type);
  let returnRegionFingerprints = entry.regionFingerprints ? { ...entry.regionFingerprints } : undefined;
  // Update per-region fingerprints separately: APV routes each parallel region independently for migration decisions
  if (returnRegionFingerprints) {
    for (const [regionName, regionStateVal] of Object.entries(parallelRegions)) {
      const fullRegionPath = `${parallelRoot}.${regionName}`;
      const leafStr        = typeof regionStateVal === 'string' ? regionStateVal : stateKeyOf(regionStateVal);
      const oldKey         = `${parallelRoot}.${regionName}.${leafStr}`;
      const newKey         = regionFullKeys[fullRegionPath];
      if (newKey && newKey !== oldKey) {
        returnRegionFingerprints[fullRegionPath] = updateFingerprint(
          returnRegionFingerprints[fullRegionPath] ?? '0', event.type
        );
      }
    }
  }

  const newEntryId     = randomInt(0, 2 ** 32);
  const invokesToStart = (compiledJson.invokeStates?.[stateKeyOf(returnStateValue)] ?? []).map(inv => ({
    id: inv.id ?? inv.src, src: inv.src ?? inv.id,
  }));

  return {
    stateValue:         returnStateValue,
    context,
    historyFingerprint: newFingerprint,
    stateEntryId:       newEntryId,
    regionFingerprints: returnRegionFingerprints,
    done:               isDone,
    scheduledEventOps:  schedOps,
    tier2Actions:       tier2,
    durableActions:     durable,
    invokesToStart,
  };
}

// ── processEvent ──────────────────────────────────────────────────────────────

/**
 * processEvent — main hot-path function.
 *
 * @param {object} entry        — hot registry entry: { stateValue, context, historyFingerprint, stateEntryId }
 * @param {object} compiledJson — compiled form from definitionCompiler
 * @param {object} event        — { type, payload?, ... }
 * @param {object} registry     — { guards, actions, services } from implementationRegistry
 * @param {Array}  pendingSends — cross-actor sends queued during this transition (mutated)
 *
 * @returns {{ stateValue, context, historyFingerprint, stateEntryId, done,
 *             scheduledEventOps, tier2Actions, durableActions }}
 */
export function processEvent(entry, compiledJson, event, registry, pendingSends = []) {
  const { transitions, transientStates, entryActions, exitActions, afterTransitions, finalStates } = compiledJson;

  // Detect parallel state; branch to full multi-region dispatch
  const _sv = entry.stateValue;
  if (typeof _sv === 'object' && _sv !== null) {
    const _topKey    = Object.keys(_sv)[0];
    const _regionMap = _sv[_topKey];
    const isParallel = (_regionMap && typeof _regionMap === 'object'
      && !Array.isArray(_regionMap) && Object.keys(_regionMap).length >= 2)
      || compiledJson.parallelStates?.includes(_topKey);
    if (isParallel) {
      // Check for a direct root-level transition first (e.g., parallel root has
      // on: { COMPLETE: 'done' } — exits the entire parallel block).
      // The per-region dispatch would find this via bubble-up but then
      // incorrectly interpret the target as a sub-region leaf state.
      const rootTx = transitions?.[`${_topKey}:${event.type}`];
      if (rootTx?.length > 0) {
        // Delegate to the flat path using the parallel root key as "current state"
        // so exit/entry action lookups and transition selection are correct.
        return processEvent(
          { ...entry, stateValue: _topKey },
          compiledJson, event, registry, pendingSends
        );
      }
      const ctx = entry.context;
      const tier2 = [], durable = [], schedOps = [];
      return _processParallelEvent(
        entry, compiledJson, event, registry, pendingSends,
        _topKey, _regionMap, tier2, durable, schedOps, ctx
      );
    }
  }

  const oldStateKey = stateKeyOf(entry.stateValue);
  const candidates  = findCandidates(oldStateKey, event.type, transitions);

  // No transition for this event — silent ignore (valid XState behaviour)
  if (!candidates) {
    return {
      stateValue:         entry.stateValue,
      context:            entry.context,
      historyFingerprint: entry.historyFingerprint,
      stateEntryId:       entry.stateEntryId,
      done:               false,
      scheduledEventOps:  [],
      tier2Actions:       [],
      durableActions:     [],
    };
  }

  // Find first passing candidate
  let winner = null;
  for (const c of candidates) {
    if (evalGuard(c.guard, entry.context, event, registry)) { winner = c; break; }
  }
  if (!winner) {
    return {
      stateValue:         entry.stateValue,
      context:            entry.context,
      historyFingerprint: entry.historyFingerprint,
      stateEntryId:       entry.stateEntryId,
      done:               false,
      scheduledEventOps:  [],
      tier2Actions:       [],
      durableActions:     [],
    };
  }

  // Snapshot context reference before any tier-1 assign actions can produce a new object.
  // Tier-1 assigns return new objects (never mutate in place), so restoring this reference
  // is zero-cost and sufficient to roll back all mutations on transient-loop bail.
  const contextSnapshot = entry.context;
  let context    = entry.context;
  const tier2    = [];
  const durable  = [];
  const schedOps = [];

  // meta object for actions (cross-actor sends deferred post-transition)
  const meta = {
    actorId: entry.actorId,
    send:  (targetId, ev) => pendingSends.push({ targetId, event: ev }),
    raise: (ev) => pendingSends.push({ targetId: entry.actorId, event: ev }),
    emit:  () => {},
  };

  // Exit actions for old state — fires first, sees pre-transition context (XState semantics)
  for (const actionName of (exitActions[oldStateKey] ?? [])) {
    const classified = classifyAction(actionName, registry);
    if (!classified) continue;
    if (classified.type === 'tier1') {
      try {
        const result = classified.fn({ context, event }, meta);
        if (result && typeof result === 'object' && !result.then) {
          context = { ...context, ...result };
        }
      } catch {}
    } else if (classified.type === 'tier2') {
      tier2.push({ name: actionName, fn: classified.fn, context, event });
    } else if (classified.type === 'durable') {
      durable.push({ name: actionName, fn: classified.fn, context, event, opts: classified.fn.__sk_durable });
    }
  }

  // Tier-1 actions on transition (assign, etc.) — run synchronously now
  for (const actionName of (winner.actions ?? [])) {
    const classified = classifyAction(actionName, registry);
    if (!classified) continue;
    if (classified.type === 'tier1') {
      try {
        const result = classified.fn({ context, event }, meta);
        if (result && typeof result === 'object' && !result.then) {
          context = { ...context, ...result };
        }
      } catch (err) {
        console.error(`[interpreter] Tier-1 action '${actionName}' threw:`, err.message);
      }
    } else if (classified.type === 'tier2') {
      tier2.push({ name: actionName, fn: classified.fn, context, event });
    } else if (classified.type === 'durable') {
      durable.push({ name: actionName, fn: classified.fn, context, event, opts: classified.fn.__sk_durable });
    }
  }

  // after: ops are returned as data (scheduledEventOps), not executed here — interpreter has no I/O; actorManager processes them post-commit
  // Cancel after: scheduled events for old state
  if (afterTransitions[oldStateKey]) {
    schedOps.push({ op: 'cancel', stateKey: oldStateKey });
  }

  // Update state
  let newStateKey    = winner.target ?? oldStateKey;
  const newEntryId   = randomInt(0, 2 ** 32);

  // Handle always (transient) chains
  let transientDepth = 0;
  while (transientStates[newStateKey] && transientDepth < MAX_TRANSIENT_DEPTH) {
    transientDepth++;
    const transients = transientStates[newStateKey];
    let transWinner  = null;
    for (const t of transients) {
      if (evalGuard(t.guard, context, event, registry)) { transWinner = t; break; }
    }
    if (!transWinner) break;
    newStateKey = transWinner.target ?? newStateKey;
  }
  if (transientDepth >= MAX_TRANSIENT_DEPTH && transientStates[newStateKey]) {
    // Actor goes to needs_rescue — caller detects via special flag.
    // Return contextSnapshot (pre-mutation) and empty action arrays so no
    // side-effects fire for a transition that did not successfully complete.
    return {
      stateValue:         entry.stateValue,
      context:            contextSnapshot,
      historyFingerprint: entry.historyFingerprint,
      stateEntryId:       entry.stateEntryId,
      done:               false,
      error:              'TRANSIENT_LOOP_DETECTED',
      scheduledEventOps:  [],
      tier2Actions:       [],
      durableActions:     [],
      invokesToStart:     [],
    };
  }

  // Bug #1B: descend into compound state's initial child until we reach a leaf.
  // Fires entry actions for each intermediate compound parent before descending.
  while (compiledJson.compoundInitials?.[newStateKey]) {
    const parentKey = newStateKey;
    const childKey  = compiledJson.compoundInitials[newStateKey];
    for (const actionName of (entryActions[parentKey] ?? [])) {
      const classified = classifyAction(actionName, registry);
      if (!classified) continue;
      if (classified.type === 'tier1') {
        try {
          const result = classified.fn({ context, event }, meta);
          if (result && typeof result === 'object' && !result.then) {
            context = { ...context, ...result };
          }
        } catch {}
      } else if (classified.type === 'tier2') {
        tier2.push({ name: actionName, fn: classified.fn, context, event });
      } else if (classified.type === 'durable') {
        durable.push({ name: actionName, fn: classified.fn, context, event, opts: classified.fn.__sk_durable });
      }
    }
    // Arm after: timers for the compound parent state as we pass through it
    if (afterTransitions[parentKey]) {
      schedOps.push({ op: 'create', stateKey: parentKey, newEntryId, entries: afterTransitions[parentKey] });
    }
    newStateKey = childKey;
  }

  // Entry actions for new state
  for (const actionName of (entryActions[newStateKey] ?? [])) {
    const classified = classifyAction(actionName, registry);
    if (!classified) continue;
    if (classified.type === 'tier1') {
      try {
        const result = classified.fn({ context, event }, meta);
        if (result && typeof result === 'object' && !result.then) {
          context = { ...context, ...result };
        }
      } catch {}
    } else if (classified.type === 'tier2') {
      tier2.push({ name: actionName, fn: classified.fn, context, event });
    } else if (classified.type === 'durable') {
      durable.push({ name: actionName, fn: classified.fn, context, event, opts: classified.fn.__sk_durable });
    }
  }

  // Create after: scheduled events for new state
  if (afterTransitions[newStateKey]) {
    schedOps.push({ op: 'create', stateKey: newStateKey, newEntryId, entries: afterTransitions[newStateKey] });
  }

  // Update fingerprint
  const newFingerprint = updateFingerprint(entry.historyFingerprint, event.type);
  // For non-parallel actors this is the final answer; parallel block below may override (Bug 3 fix).
  let isDone = compiledJson.finalStates?.includes(newStateKey) ?? false;

  const invokesToStart = (compiledJson.invokeStates?.[newStateKey] ?? []).map(inv => ({
    id:  inv.id  ?? inv.src,   // used as done.invoke.${id} event name
    src: inv.src ?? inv.id,    // used for registry.services[src] lookup
  }));

  // Non-parallel: stateValue is a single state key
  const returnStateValue = keyToStateValue(newStateKey);

  return {
    stateValue:         returnStateValue,
    context,
    historyFingerprint: newFingerprint,
    stateEntryId:       newEntryId,
    done:               isDone,
    scheduledEventOps:  schedOps,
    tier2Actions:       tier2,
    durableActions:     durable,
    invokesToStart,
  };
}
