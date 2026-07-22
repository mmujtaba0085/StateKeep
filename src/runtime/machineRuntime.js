// src/runtime/machineRuntime.js
//
// Public facade for all machine execution.
// No xstate import. Import this instead of xstate in all server-side code.

export { processEvent, computeInitialSnapshot, stateKeyOf, keyToStateValue } from './interpreter.js';
export { compileMachine } from './definitionCompiler.js';

import { stateKeyOf }                             from './interpreter.js';
import { computeInitialSnapshot, processEvent }   from './interpreter.js';

function _collectStateKeys(states, prefix = '') {
  const keys = new Set();
  for (const [name, cfg] of Object.entries(states || {})) {
    const key = prefix ? `${prefix}.${name}` : name;
    keys.add(key);
    if (cfg?.states) {
      for (const k of _collectStateKeys(cfg.states, key)) keys.add(k);
    }
  }
  return keys;
}

/**
 * restoreSnapshot — restore an actor to a known landing state WITHOUT entry actions.
 * HYDRATE semantics: actor is being restored after migration, not freshly spawned.
 *
 * Returns { stateValue, context } on success, or { error: string } on failure.
 */
export function restoreSnapshot(compiledJson, landingStateValue, transformedContext) {
  const { runtimeDef, parallelStates = [] } = compiledJson;
  // Use runtimeDef to enumerate ALL states (including those with no transitions)
  const knownKeys = runtimeDef
    ? _collectStateKeys(runtimeDef.states)
    : new Set(parallelStates);

  const landingKey = stateKeyOf(landingStateValue);
  const rootKey    = typeof landingStateValue === 'object' && landingStateValue !== null
    ? Object.keys(landingStateValue)[0]
    : null;

  if (!knownKeys.has(landingKey) && !(rootKey && knownKeys.has(rootKey))) {
    return { error: 'STATE_NOT_FOUND' };
  }

  return { stateValue: landingStateValue, context: transformedContext };
}

/**
 * runScenario — dry-run an event sequence without persisting anything.
 * Used by POST /v1/definitions/scenario.
 *
 * Returns { name, passed, steps, finalState, done, error? }
 */
export function runScenario(compiledJson, definitionJson, scenario) {
  const { name = '(unnamed)', initialContext = {}, events = [], expectedStates = [] } = scenario;
  const emptyRegistry = { guards: {}, actions: {}, services: {} };
  const steps = [];

  const snapResult = computeInitialSnapshot(compiledJson, definitionJson, initialContext, emptyRegistry);
  if (snapResult.error) {
    return { name, passed: false, steps, finalState: null, done: false, error: snapResult.error };
  }

  let entry = {
    stateValue:         snapResult.stateValue,
    context:            snapResult.context,
    historyFingerprint: snapResult.historyFingerprint,
    stateEntryId:       snapResult.stateEntryId,
  };
  let isDone = snapResult.done;

  for (let i = 0; i < events.length; i++) {
    if (isDone) break;
    const raw      = events[i];
    const eventObj = typeof raw === 'string' ? { type: raw } : raw;

    const result = processEvent(entry, compiledJson, eventObj, emptyRegistry, []);
    isDone = result.done;
    entry  = {
      stateValue:         result.stateValue,
      context:            result.context,
      historyFingerprint: result.historyFingerprint,
      stateEntryId:       result.stateEntryId,
    };

    const expected   = expectedStates[i] ?? null;
    const stepPassed = expected === null
      || JSON.stringify(result.stateValue) === JSON.stringify(expected);
    steps.push({
      step:     i + 1,
      event:    eventObj.type,
      state:    result.stateValue,
      expected: expected ?? '(any)',
      pass:     stepPassed,
    });
  }

  return {
    name,
    passed:     steps.every(s => s.pass),
    steps,
    finalState: entry.stateValue,
    done:       isDone,
  };
}
