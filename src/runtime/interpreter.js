// src/runtime/interpreter.js
//
// Main-thread event processor. Replaces XState on the EVENT hot path.
// No XState import. No async I/O. Returns synchronously.
// Async side-effects (tier2Actions, durableActions, scheduledEventOps) are
// returned as data — callers execute them after state is committed.

import { randomInt }         from 'crypto';
import { updateFingerprint } from '../ffi/fingerprintChain.js';

const MAX_TRANSIENT_DEPTH = 100;

// Minor fix: deduplicate missing-guard warnings (avoid log flood at 30k ev/s)
const _warnedGuards   = new Set();
// Bug 1 fix: deduplicate parallel-detection warnings (fire at most once per root key)
const _warnedParallel = new Set();

// ── State key helpers ─────────────────────────────────────────────────────────

/** Extract the canonical string key from a stateValue (flat or compound). */
function stateKeyOf(stateValue) {
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
function keyToStateValue(key) {
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

  // Bug #2: detect parallel state using parallelStates (compiler-recorded) or stateValue shape.
  // A parallel stateValue has an object top-value with 2+ region keys; compound top-value is a string.
  let _parallelRoot    = null;   // e.g. 'root'
  let _parallelRegions = null;   // e.g. { regionA: 'a1', regionB: 'b1' }
  const _sv = entry.stateValue;
  if (typeof _sv === 'object' && _sv !== null) {
    const _topKey    = Object.keys(_sv)[0];
    const _regionMap = _sv[_topKey];
    const _isParallelByShape = _regionMap && typeof _regionMap === 'object'
      && !Array.isArray(_regionMap) && Object.keys(_regionMap).length >= 2;
    const _isParallelByMeta  = compiledJson.parallelStates?.includes(_topKey);
    if (_isParallelByShape || _isParallelByMeta) {
      _parallelRoot    = _topKey;
      _parallelRegions = _regionMap;
      // Bug 1 fix: emit at most once per parallel root key per process lifetime
      if (!_warnedParallel.has(_topKey)) {
        _warnedParallel.add(_topKey);
        console.warn(
          `[StateKeep] parallel actor state "${_topKey}": full multi-region dispatch not implemented — ` +
          `processing first-region transition only; other regions unchanged.`
        );
      }
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
    // Actor goes to needs_rescue — caller detects via special flag
    return {
      stateValue:         entry.stateValue,
      context,
      historyFingerprint: entry.historyFingerprint,
      stateEntryId:       entry.stateEntryId,
      done:               false,
      error:              'TRANSIENT_LOOP_DETECTED',
      scheduledEventOps:  [],
      tier2Actions:       [],
      durableActions:     [],
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

  const invokesToStart = (compiledJson.invokeStates?.[newStateKey] ?? []).map(inv => inv.src ?? inv.id);

  // Bug #2: reconstruct parallel stateValue and update regionFingerprints for the changed region.
  // Only the first-region transition is applied; all other regions remain unchanged.
  let returnStateValue        = keyToStateValue(newStateKey);
  let returnRegionFingerprints;   // undefined → caller falls back to entry.regionFingerprints

  if (_parallelRoot && _parallelRegions) {
    const newRegions   = { ..._parallelRegions };
    const rootPrefix   = `${_parallelRoot}.`;

    // Build a map of regionName → full dotted state key (for Bug 3 isDone check).
    // Start from current _parallelRegions values (unchanged regions), then override
    // the one region that actually transitioned.
    const regionFullKeys = {};
    for (const [rName, rVal] of Object.entries(_parallelRegions)) {
      const leafStr = typeof rVal === 'string' ? rVal : stateKeyOf(rVal);
      regionFullKeys[rName] = `${_parallelRoot}.${rName}.${leafStr}`;
    }

    if (newStateKey.startsWith(rootPrefix)) {
      const afterRoot  = newStateKey.slice(rootPrefix.length);
      const dotIdx     = afterRoot.indexOf('.');
      const regionName = dotIdx >= 0 ? afterRoot.slice(0, dotIdx) : afterRoot;
      const newLeaf    = dotIdx >= 0 ? afterRoot.slice(dotIdx + 1) : afterRoot;

      if (regionName in newRegions) {
        const oldLeaf = newRegions[regionName];
        // Bug 2 fix: convert flat 'step.substep' leaf to nested { step: 'substep' } for
        // XState v4 stateValue format; flat single-segment leaves stay as plain strings.
        newRegions[regionName] = keyToStateValue(newLeaf);

        // The transitioned region now has a new full path = newStateKey (already correct).
        regionFullKeys[regionName] = newStateKey;

        // Update regionFingerprints for the region that actually transitioned
        if (oldLeaf !== newLeaf && entry.regionFingerprints) {
          const rfpKey = `${_parallelRoot}.${regionName}`;
          returnRegionFingerprints = {
            ...entry.regionFingerprints,
            [rfpKey]: updateFingerprint(entry.regionFingerprints[rfpKey] ?? '0', event.type),
          };
        }
      }
    }

    // Bug 3 fix: for parallel actors, isDone only when ALL regions are in final states.
    const group = compiledJson.parallelGroups?.find(g => g.parent === _parallelRoot);
    if (group) {
      isDone = group.children.every(childRegion => {
        const fullKey = regionFullKeys[childRegion];
        return fullKey != null && (compiledJson.finalStates?.includes(fullKey) ?? false);
      });
    } else {
      // No parallelGroups metadata — cannot determine; conservatively not done.
      isDone = false;
    }

    returnStateValue = { [_parallelRoot]: newRegions };
  }

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
