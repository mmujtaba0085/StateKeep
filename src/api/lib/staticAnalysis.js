/**
 * src/api/lib/staticAnalysis.js
 *
 * Static analysis of XState v5 machine definitions.
 * Returns { errors, warnings } — errors block storage, warnings are informational.
 *
 * Hard errors (status 400 on PUT / valid:false on /validate):
 *   EMPTY_STATES           — states object is missing or empty
 *   INVALID_INITIAL        — `initial` references a state that doesn't exist
 *   COMPOUND_NO_INITIAL    — a compound state is missing its own `initial`
 *   INVALID_TRANSITION     — a transition targets a state that doesn't exist
 *   UNDEFINED_INITIAL      — initial state resolves to undefined after compilation
 *   COMPILE_ERROR          — compileMachine threw during compilation
 *
 * Soft warnings (stored, returned in response but don't block):
 *   DEAD_END_STATE         — non-final state with no outgoing transitions
 *   UNREACHABLE_STATE      — state with no path from `initial`
 *   NO_TERMINAL_STATE      — machine has zero final states
 *
 * NOTE: Analysis is shallow — only top-level states are checked for
 * reachability and dead-ends. Nested/parallel sub-states are not walked.
 * XState-level errors always take priority over static checks.
 */

import { compileMachine, computeInitialSnapshot } from '../../runtime/machineRuntime.js';

const _emptyRegistry = { guards: {}, actions: {}, services: {} };

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyse a machine definition.
 * @param {object} definition  — the raw XState machine config JSON
 * @returns {{ errors: Issue[], warnings: Issue[] }}
 */
export function analyseDefinition(definition) {
  const errors   = [];
  const warnings = [];

  // ── Pre-XState structural checks (catch issues that cause deferred throws) ──

  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    errors.push(issue('INVALID_SHAPE', 'Definition must be a plain object'));
    return { errors, warnings };
  }

  const states = definition.states;

  // EMPTY_STATES — catches the deferred-throw gap before XState sees it
  if (!states || typeof states !== 'object' || Object.keys(states).length === 0) {
    errors.push(issue('EMPTY_STATES', 'states object is missing or empty'));
    return { errors, warnings };  // no point running further checks
  }

  const topLevelStateNames = Object.keys(states);

  // INVALID_INITIAL — initial must reference a real state
  if (definition.initial !== undefined) {
    const initial = String(definition.initial);
    if (!topLevelStateNames.includes(initial)) {
      errors.push(issue(
        'INVALID_INITIAL',
        `initial state "${initial}" does not exist in states: [${topLevelStateNames.join(', ')}]`
      ));
    }
  }

  // INVALID_TRANSITION_TARGET — transitions must target existing states (top-level only)
  for (const [stateName, stateDef] of Object.entries(states)) {
    if (!stateDef || typeof stateDef !== 'object') continue;
    const onBlock = stateDef.on;
    if (!onBlock) continue;
    for (const [eventName, target] of Object.entries(onBlock)) {
      const targetName = resolveTarget(target);
      if (targetName && !targetName.startsWith('#') && !topLevelStateNames.includes(targetName)) {
        errors.push(issue(
          'INVALID_TRANSITION',
          `State "${stateName}" transitions to "${targetName}" on "${eventName}" but that state does not exist`
        ));
      }
    }
  }

  // COMPOUND_NO_INITIAL — compound states must declare their own `initial`
  for (const [stateName, stateDef] of Object.entries(states)) {
    if (!stateDef || typeof stateDef !== 'object') continue;
    const children = stateDef.states;
    if (children && typeof children === 'object' && Object.keys(children).length > 0) {
      if (stateDef.type !== 'parallel' && !stateDef.initial) {
        errors.push(issue(
          'COMPOUND_NO_INITIAL',
          `Compound state "${stateName}" has child states but no "initial" property`
        ));
      }
    }
  }

  // ── Compile check ─────────────────────────────────────────────────────────

  let compiledJson = null;
  if (errors.length === 0) {
    const { compiled, error: compileError } = tryCompileMachine(definition);
    if (compileError) {
      errors.push(issue('COMPILE_ERROR', compileError));
      return { errors, warnings, compiledJson: null };
    }
    compiledJson = compiled;

    // Verify initial state resolves — catches deferred issues the structural
    // checks above may not catch (e.g. transient-loop at initial state).
    const initialError = checkInitialResolvable(compiledJson, definition);
    if (initialError) {
      errors.push(issue('UNDEFINED_INITIAL', initialError));
      return { errors, warnings, compiledJson: null };
    }
  }

  // If there are hard errors, stop — no point running soft checks
  if (errors.length > 0) return { errors, warnings, compiledJson: null };

  // ── Soft warnings (static graph analysis) ────────────────────────────────

  // NO_TERMINAL_STATE
  const finalStates = topLevelStateNames.filter(s => states[s]?.type === 'final');
  if (finalStates.length === 0) {
    warnings.push(issue(
      'NO_TERMINAL_STATE',
      'Machine has no final states — actors will never terminate automatically'
    ));
  }

  // UNREACHABLE_STATE — BFS from initial
  // Limitations of shallow analysis:
  // 1. We only follow top-level on/always transitions. Compound sub-states may
  //    have transitions that exit to sibling top-level states via absolute IDs
  //    (e.g. '#wizard.step2') which we cannot follow without full machine walking.
  // 2. We skip warnings for any state that is referenced by an absolute-ID target
  //    anywhere in the definition (these are reachable but not via simple BFS).
  if (definition.initial) {
    const reachable   = bfsReachable(definition.initial, states);
    // Collect all absolute-ID references: '#machineId.stateName' → extract 'stateName'
    const absReferenced = collectAbsoluteTargets(definition);
    const unreachable = topLevelStateNames.filter(s =>
      !reachable.has(s) && !absReferenced.has(s)
    );
    for (const s of unreachable) {
      warnings.push(issue(
        'UNREACHABLE_STATE',
        `State "${s}" is not reachable from initial state "${definition.initial}" — check that at least one transition targets it`
      ));
    }
  }

  // DEAD_END_STATE — non-final state with zero outgoing transitions
  for (const stateName of topLevelStateNames) {
    const stateDef = states[stateName];
    if (!stateDef || stateDef.type === 'final') continue;
    const hasTransitions = (
      (stateDef.on && Object.keys(stateDef.on).length > 0) ||
      stateDef.always ||
      stateDef.after  ||
      // Compound / parallel states delegate to children
      (stateDef.states && Object.keys(stateDef.states ?? {}).length > 0)
    );
    if (!hasTransitions) {
      warnings.push(issue(
        'DEAD_END_STATE',
        `State "${stateName}" is not final but has no outgoing transitions — actors will be permanently stuck here`
      ));
    }
  }

  return { errors, warnings, compiledJson };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function issue(type, message, severity) {
  return {
    type,
    severity: severity ?? (type.endsWith('_STATE') || type === 'NO_TERMINAL_STATE' ? 'warning' : 'error'),
    message,
  };
}

/** Extract the target state name from various XState transition shapes. */
function resolveTarget(target) {
  if (!target) return null;
  if (typeof target === 'string') return target;
  // Array of conditional transitions: [{ target, guard }, { target }]
  if (Array.isArray(target)) {
    const last = target[target.length - 1];
    return resolveTarget(last);
  }
  if (typeof target === 'object') {
    // { target: 'stateName' } or { target: ['stateName'] }
    const t = target.target;
    if (typeof t === 'string') return t;
    if (Array.isArray(t)) return t[0];
    return null;
  }
  return null;
}

/**
 * Collect state names referenced via absolute IDs (#machineId.stateName)
 * anywhere in the definition JSON. These are reachable but BFS can't follow them.
 */
function collectAbsoluteTargets(definition) {
  const referenced = new Set();
  const json       = JSON.stringify(definition);
  // Match '#anyId.stateName' patterns — capture the last segment
  const matches    = json.matchAll(/#[^".\\/]+\.([^"#\\/]+)/g);
  for (const m of matches) {
    referenced.add(m[1]);
  }
  return referenced;
}

/** BFS from initial state, returns Set of reachable state names. */
function bfsReachable(initial, states) {
  const visited = new Set();
  const queue   = [String(initial)];
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    const stateDef = states[current];
    if (!stateDef || typeof stateDef !== 'object') continue;
    // Follow on-transitions
    for (const target of Object.values(stateDef.on ?? {})) {
      const t = resolveTarget(target);
      if (t && !t.startsWith('#') && !visited.has(t)) queue.push(t);
      // Array of conditional transitions
      if (Array.isArray(target)) {
        for (const branch of target) {
          const bt = resolveTarget(branch);
          if (bt && !bt.startsWith('#') && !visited.has(bt)) queue.push(bt);
        }
      }
    }
    // Follow always-transitions
    if (Array.isArray(stateDef.always)) {
      for (const branch of stateDef.always) {
        const t = resolveTarget(branch);
        if (t && !visited.has(t)) queue.push(t);
      }
    }
  }
  return visited;
}

/** Attempt compileMachine — returns { compiled, error }. */
function tryCompileMachine(definition) {
  try {
    return { compiled: compileMachine(definition), error: null };
  } catch (e) {
    return { compiled: null, error: e.message };
  }
}

/**
 * Verify the initial state is reachable via computeInitialSnapshot.
 * Catches issues like transient loops or missing initial paths.
 * Returns error string on failure, null on success.
 */
function checkInitialResolvable(compiledJson, definitionJson) {
  try {
    const result = computeInitialSnapshot(compiledJson, definitionJson, {}, _emptyRegistry);
    if (result.error) {
      return `Machine initial state could not be resolved: ${result.error}`;
    }
    if (result.stateValue === undefined || result.stateValue === null) {
      return `Machine started but initial state resolved to undefined — check that "initial" matches a real state name`;
    }
    return null;
  } catch (e) {
    return e.message;
  }
}
