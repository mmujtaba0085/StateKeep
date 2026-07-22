/**
 * src/runtime/actorWorker.js
 *
 * Worker thread entry point. Manages actor state snapshots for SPAWN, HYDRATE,
 * and TERMINATE operations. Events are processed on the main thread via interpreter.js.
 *
 * Message protocol:
 *   Inbound  { id, type, ...payload }
 *   Outbound { id, ok, result?, error? }
 *
 * Supported message types:
 *   SPAWN        { actorId, definitionId, definitionJson, stateSnapshot?, initialContext? }
 *   EVENT        { actorId, event, historyFingerprint, regionFingerprints }
 *   SNAPSHOT     { actorId }
 *   HYDRATE      { actorId, targetDefinitionId, targetDefinitionJson, oldContext, ... }
 *   TERMINATE    { actorId }
 *   PING         {}
 *   PRECOMPILE   { definitionId, definitionJson }
 *   BATCH_EVENTS { actorId, events }
 */

import { parentPort }             from 'worker_threads';
import {
  processEvent,
  computeInitialSnapshot,
  restoreSnapshot,
  compileMachine,
}                                 from './machineRuntime.js';
import {
  initializeRegionFingerprints,
  updateRegionFingerprintsForTransition,
}                                 from './statePaths.js';

// ── Context transform helpers ─────────────────────────────────────────────────

export function getNestedValue(obj, path) {
  if (!obj || typeof obj !== 'object' || !path) return undefined;
  return String(path).split('.').reduce(
    (current, key) => current != null ? current[key] : undefined,
    obj
  );
}

export function setNestedValue(obj, path, value) {
  if (!obj || typeof obj !== 'object' || !path) return obj;
  const keys = String(path).split('.');
  const last = keys.pop();
  let curr = obj;
  for (const key of keys) {
    if (curr[key] == null || typeof curr[key] !== 'object') curr[key] = {};
    curr = curr[key];
  }
  curr[last] = value;
  return obj;
}

export function applyContextTransform(context, transform) {
  if (!transform || typeof transform !== 'object' || Object.keys(transform).length === 0) {
    return context;
  }
  if (context == null || typeof context !== 'object') {
    throw new Error('applyContextTransform: context must be a non-null object');
  }
  const result = JSON.parse(JSON.stringify(context));
  for (const [newPath, oldPath] of Object.entries(transform)) {
    if (typeof newPath !== 'string' || typeof oldPath !== 'string') continue;
    const value = getNestedValue(context, oldPath);
    if (value !== undefined) setNestedValue(result, newPath, value);
  }
  return result;
}

// ── Actor store ───────────────────────────────────────────────────────────────

/**
 * Map<actorId, { stateValue, context, historyFingerprint, stateEntryId,
 *                regionFingerprints, definitionId, done }>
 */
const actors = new Map();

// ── Compiled machine cache ────────────────────────────────────────────────────

const MACHINE_CACHE_MAX     = 512;
const _compiledCache        = new Map();   // definitionId → compiledJson
const _definitionJsonCache  = new Map();   // definitionId → definitionJson
const _definitionRefCounts  = new Map();

function evictOldestCacheEntry() {
  for (const definitionId of _compiledCache.keys()) {
    if ((_definitionRefCounts.get(definitionId) ?? 0) > 0) continue;
    _compiledCache.delete(definitionId);
    _definitionJsonCache.delete(definitionId);
    return true;
  }
  return false;
}

function trimMachineCache() {
  while (_compiledCache.size >= MACHINE_CACHE_MAX) {
    if (!evictOldestCacheEntry()) return;
  }
}

function retainDefinition(definitionId) {
  if (!definitionId) return;
  _definitionRefCounts.set(definitionId, (_definitionRefCounts.get(definitionId) ?? 0) + 1);
}

function releaseDefinition(definitionId) {
  if (!definitionId) return;
  const next = (_definitionRefCounts.get(definitionId) ?? 0) - 1;
  if (next > 0) _definitionRefCounts.set(definitionId, next);
  else _definitionRefCounts.delete(definitionId);
}

function setActorEntry(actorId, entry) {
  const previous = actors.get(actorId);
  if (previous?.definitionId !== entry.definitionId) {
    releaseDefinition(previous?.definitionId);
    retainDefinition(entry.definitionId);
  }
  actors.set(actorId, entry);
}

function removeActorEntry(actorId) {
  const previous = actors.get(actorId);
  if (!previous) return null;
  actors.delete(actorId);
  releaseDefinition(previous.definitionId);
  return previous;
}

function getOrCompileDefinition(cacheKey, definitionJson) {
  if (cacheKey && _compiledCache.has(cacheKey)) {
    return {
      compiledJson:  _compiledCache.get(cacheKey),
      definitionJson: _definitionJsonCache.get(cacheKey) ?? definitionJson,
    };
  }
  const compiledJson = compileMachine(definitionJson);
  if (cacheKey) {
    trimMachineCache();
    _compiledCache.set(cacheKey, compiledJson);
    _definitionJsonCache.set(cacheKey, definitionJson);
  }
  return { compiledJson, definitionJson };
}

const emptyRegistry = { guards: {}, actions: {}, services: {} };

// ── Serialization ─────────────────────────────────────────────────────────────

function serializeEntry(entry, actorId) {
  return {
    actorId,
    stateValue:         entry.stateValue,
    context:            entry.context,
    historyFingerprint: entry.historyFingerprint,
    regionFingerprints: entry.regionFingerprints ?? null,
    status:             entry.done ? 'done' : 'active',
    done:               entry.done ?? false,
  };
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleSpawn({ actorId, definitionId, definitionJson, stateSnapshot, initialContext, existingRegionFingerprints }) {
  if (actors.has(actorId)) return serializeEntry(actors.get(actorId), actorId);

  const { compiledJson, definitionJson: defJson } = getOrCompileDefinition(definitionId, definitionJson);

  let stateValue, context, historyFingerprint, stateEntryId, done;

  if (stateSnapshot) {
    // Re-loading evicted actor from persisted snapshot — no entry actions
    const r = restoreSnapshot(compiledJson, stateSnapshot.value, stateSnapshot.context);
    if (r.error) return { error: r.error };
    stateValue         = r.stateValue;
    context            = r.context;
    historyFingerprint = '0';
    stateEntryId       = 0;
    done               = false;
  } else {
    // Fresh spawn — runs entry actions and chases transient chains
    const r = computeInitialSnapshot(compiledJson, defJson, initialContext ?? {}, emptyRegistry);
    if (r.error) return { error: r.error };
    stateValue         = r.stateValue;
    context            = r.context;
    historyFingerprint = r.historyFingerprint;
    stateEntryId       = r.stateEntryId ?? 0;
    done               = r.done;
  }

  const regionFingerprints = initializeRegionFingerprints(defJson, stateValue, existingRegionFingerprints ?? null);
  setActorEntry(actorId, { stateValue, context, historyFingerprint, stateEntryId, regionFingerprints, definitionId, done });

  return { actorId, stateValue, context, historyFingerprint, regionFingerprints, status: done ? 'done' : 'active', done };
}

function handleEvent({ actorId, event, historyFingerprint, regionFingerprints }) {
  const entry = actors.get(actorId);
  if (!entry) throw new Error(`Actor ${actorId} not in worker`);

  const { definitionId } = entry;
  const compiledJson = _compiledCache.get(definitionId);
  if (!compiledJson) throw new Error(`Definition ${definitionId} not compiled in worker cache`);
  const defJson = _definitionJsonCache.get(definitionId);

  const preSV = entry.stateValue;
  const result = processEvent(
    {
      stateValue:         entry.stateValue,
      context:            entry.context,
      historyFingerprint: historyFingerprint ?? entry.historyFingerprint,
      stateEntryId:       entry.stateEntryId,
      regionFingerprints: regionFingerprints ?? entry.regionFingerprints,
    },
    compiledJson,
    event,
    emptyRegistry,
    [],
  );

  const newRegionFingerprints = updateRegionFingerprintsForTransition(
    defJson,
    preSV,
    result.stateValue,
    event.type,
    regionFingerprints ?? entry.regionFingerprints ?? null,
  );

  setActorEntry(actorId, {
    ...entry,
    stateValue:         result.stateValue,
    context:            result.context,
    historyFingerprint: result.historyFingerprint,
    stateEntryId:       result.stateEntryId,
    regionFingerprints: newRegionFingerprints,
    done:               result.done,
  });

  return {
    actorId,
    stateValue:         result.stateValue,
    context:            result.context,
    historyFingerprint: result.historyFingerprint,
    regionFingerprints: newRegionFingerprints,
    status:             result.done ? 'done' : 'active',
    done:               result.done,
  };
}

/**
 * Resolve where an actor should land in the new machine.
 *
 * For flat machines: returns the landing state name (string).
 * For compound/parallel machines: returns the full compound state value object
 *   when the top-level key exists in newMachineStates.
 *
 * stateMapping keys are always top-level state names (strings).
 * Returns null if no mapping is possible (actor needs_rescue).
 *
 * Exported so it can be unit-tested without a running server.
 */
export function resolveLandingState(currentStateValue, newMachineStates, stateMapping = {}) {
  if (typeof currentStateValue === 'string') {
    if (newMachineStates[currentStateValue]) return currentStateValue;
    const mapped = stateMapping[currentStateValue];
    if (mapped && newMachineStates[mapped]) return mapped;
    return null;
  }

  if (currentStateValue && typeof currentStateValue === 'object') {
    const topLevel = Object.keys(currentStateValue)[0];
    if (!topLevel) return null;
    const mappedKey = stateMapping[topLevel];
    if (mappedKey) {
      return newMachineStates[mappedKey] ? mappedKey : null;
    }
    if (newMachineStates[topLevel]) return currentStateValue;
    return null;
  }

  return null;
}

function handleHydrate({
  actorId,
  targetDefinitionId,
  targetDefinitionJson,
  oldContext,
  currentStateValue,
  stateMapping,
  existingFingerprint,
  existingRegionFingerprints,
  contextTransform,
}) {
  removeActorEntry(actorId);

  const { compiledJson, definitionJson } = getOrCompileDefinition(targetDefinitionId, targetDefinitionJson);
  const newStates = targetDefinitionJson.states ?? {};

  let transformedContext;
  try {
    transformedContext = applyContextTransform(oldContext ?? {}, contextTransform);
  } catch (err) {
    return { error: 'CONTEXT_TRANSFORM_FAILED', message: err.message };
  }

  let landingStateValue;
  if (currentStateValue != null) {
    const landingState = resolveLandingState(currentStateValue, newStates, stateMapping ?? {});
    if (!landingState) return { error: 'STATE_NOT_MAPPABLE', currentStateValue };
    landingStateValue = landingState;
  } else {
    // Fallback: no current position, land at initial
    landingStateValue = typeof targetDefinitionJson.initial === 'string'
      ? targetDefinitionJson.initial
      : (targetDefinitionJson.initial?.target ?? Object.keys(newStates)[0]);
  }

  const snapResult = restoreSnapshot(compiledJson, landingStateValue, transformedContext);
  if (snapResult.error) return { error: snapResult.error, currentStateValue };

  const regionFingerprints = initializeRegionFingerprints(
    targetDefinitionJson,
    snapResult.stateValue,
    existingRegionFingerprints ?? null,
  );

  setActorEntry(actorId, {
    stateValue:         snapResult.stateValue,
    context:            snapResult.context,
    historyFingerprint: existingFingerprint ?? null,
    stateEntryId:       0,
    regionFingerprints,
    definitionId:       targetDefinitionId,
    done:               false,
  });

  return {
    actorId,
    stateValue:         snapResult.stateValue,
    context:            snapResult.context,
    historyFingerprint: existingFingerprint ?? null,
    regionFingerprints,
    status:             'active',
    done:               false,
  };
}

function handleSnapshot({ actorId }) {
  const entry = actors.get(actorId);
  if (!entry) return null;
  return serializeEntry(entry, actorId);
}

function handleTerminate({ actorId }) {
  const entry = removeActorEntry(actorId);
  if (!entry) return null;
  return serializeEntry(entry, actorId);
}

// ── Message dispatch ──────────────────────────────────────────────────────────

if (parentPort) parentPort.on('message', (msg) => {
  const { id, type } = msg;

  let result = null;
  let error  = null;

  try {
    switch (type) {
      case 'SPAWN':     result = handleSpawn(msg);     break;
      case 'EVENT':     result = handleEvent(msg);     break;
      case 'HYDRATE':   result = handleHydrate(msg);   break;
      case 'SNAPSHOT':  result = handleSnapshot(msg);  break;
      case 'TERMINATE': result = handleTerminate(msg); break;
      case 'PING':      result = { alive: true, actorCount: actors.size }; break;
      case 'PRECOMPILE':
        getOrCompileDefinition(msg.definitionId, msg.definitionJson);
        result = { ok: true };
        break;
      case 'BATCH_EVENTS': {
        const results = [];
        let fp  = msg.events[0]?.historyFingerprint ?? '0';
        let rfp = msg.events[0]?.regionFingerprints ?? null;
        for (const evData of msg.events) {
          const r = handleEvent({ actorId: msg.actorId, event: evData.event, historyFingerprint: fp, regionFingerprints: rfp });
          results.push(r);
          fp  = r.historyFingerprint;
          rfp = r.regionFingerprints;
        }
        result = { results };
        break;
      }
      default: error = `Unknown message type: ${type}`;
    }
  } catch (err) {
    error = err.message;
  }

  parentPort.postMessage({ id, ok: !error, result, error });
});

if (parentPort) parentPort.postMessage({ id: '__ready__', ok: true });
