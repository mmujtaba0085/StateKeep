/**
 * src/runtime/actorWorker.js
 *
 * Worker thread entry point. Each instance manages up to ACTORS_PER_WORKER
 * XState v5 actor instances in memory.
 *
 * Message protocol:
 *   Inbound  { id, type, ...payload }
 *   Outbound { id, ok, result?, error? }
 *
 * Supported message types:
 *   SPAWN      { actorId, definitionJson, stateSnapshot? }
 *   EVENT      { actorId, event, currentSnapshot, historyFingerprint }
 *   SNAPSHOT   { actorId }
 *   HYDRATE    { actorId, targetDefinitionJson, oldContext }
 *   TERMINATE  { actorId }
 *   PING       {}
 */

import { workerData, parentPort } from 'worker_threads';
import { createMachine, createActor } from 'xstate';
import {
  initializeRegionFingerprints,
  updateRegionFingerprintsForTransition,
} from './statePaths.js';

// Local FNV-1a (mirrors fallback.js so workers don't need FFI access)
const FNV_PRIME    = 0x00000100000001B3n;
const FNV_OFFSET   = 0xcbf29ce484222325n;
const UINT64_MAX   = 0xFFFFFFFFFFFFFFFFn;

function fnv1aUpdate(hash, str) {
  const buf = Buffer.from(String(str), 'utf8');
  for (const byte of buf) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & UINT64_MAX;
  }
  return hash;
}

function updateFingerprint(hexFp, eventType) {
  // '0' is the initial sentinel meaning "no events yet" — must start from
  // FNV_OFFSET, not from 0n.  '0' is truthy in JS so the old conditional
  // was silently computing BigInt('0x0000000000000000') = 0n (wrong).
  const current = (!hexFp || hexFp === '0')
    ? FNV_OFFSET
    : BigInt(`0x${hexFp.padStart(16, '0')}`);
  const updated = fnv1aUpdate(current, eventType);
  return updated.toString(16).padStart(16, '0');
}

// ── Context transform helpers ─────────────────────────────────────────────────

/**
 * Get a nested value from an object using dot-notation path.
 * Returns undefined if any segment of the path is missing. Never throws.
 */
export function getNestedValue(obj, path) {
  if (!obj || typeof obj !== 'object' || !path) return undefined;
  return String(path).split('.').reduce(
    (current, key) => current != null ? current[key] : undefined,
    obj
  );
}

/**
 * Set a nested value in an object using dot-notation path.
 * Creates intermediate objects as needed. Mutates and returns the object. Never throws.
 */
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

/**
 * Apply a declarative field mapping to an actor context.
 *
 * transform = { "newPath": "oldPath" }  (dot-notation)
 *
 * Rules:
 * - New fields are SET from old values (additive, not destructive)
 * - Old fields are PRESERVED — migrated actors have both old and new shapes
 * - Missing old paths are silently skipped (no undefined set)
 * - Returns a deep copy when transform is non-empty; original reference when empty
 * - Throws if input context is not a non-null object
 */
export function applyContextTransform(context, transform) {
  if (!transform || typeof transform !== 'object' || Object.keys(transform).length === 0) {
    return context;  // no-op — return original reference
  }
  if (context == null || typeof context !== 'object') {
    throw new Error('applyContextTransform: context must be a non-null object');
  }
  // Deep clone via JSON round-trip (context is always JSON-serialisable — stored in SQLite)
  const result = JSON.parse(JSON.stringify(context));
  for (const [newPath, oldPath] of Object.entries(transform)) {
    if (typeof newPath !== 'string' || typeof oldPath !== 'string') continue;
    const value = getNestedValue(context, oldPath);
    if (value !== undefined) setNestedValue(result, newPath, value);
  }
  return result;
}

// ── Actor store ───────────────────────────────────────────────────────────────

/** Map<actorId, { actor, machine, definitionJson }> */
const actors = new Map();

// ── Guard / action stub helpers ───────────────────────────────────────────────

/**
 * Recursively collect all guard names referenced in a machine definition JSON.
 * Guards without implementations throw in XState v5 — providing stubs that
 * return false lets the fallback (non-guarded) branch fire instead.
 */
function extractGuardNames(obj, guards = new Set()) {
  if (!obj || typeof obj !== 'object') return guards;
  if (Array.isArray(obj)) {
    for (const item of obj) extractGuardNames(item, guards);
  } else {
    if (typeof obj.guard === 'string') guards.add(obj.guard);
    else if (obj.guard && typeof obj.guard === 'object' && typeof obj.guard.type === 'string') {
      guards.add(obj.guard.type);
    }
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') extractGuardNames(val, guards);
    }
  }
  return guards;
}

function buildDefaultGuards(definitionJson) {
  const names = extractGuardNames(definitionJson);
  const guards = {};
  for (const name of names) guards[name] = () => false;
  return guards;
}

// Compiled machine cache — keyed by definition ID (string).
// XState machines are immutable once created, so per-worker caching is safe.
const _machineCache = new Map();

function getOrCacheMachine(cacheKey, definitionJson) {
  if (cacheKey && _machineCache.has(cacheKey)) return _machineCache.get(cacheKey);
  const machine = createMachine(definitionJson).provide({ guards: buildDefaultGuards(definitionJson) });
  if (cacheKey) _machineCache.set(cacheKey, machine);
  return machine;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleSpawn({ actorId, definitionId, definitionJson, stateSnapshot, initialContext, existingRegionFingerprints }) {
  if (actors.has(actorId)) return getSnapshot(actorId);

  const machine = getOrCacheMachine(definitionId, definitionJson);
  let actor;

  if (stateSnapshot) {
    // Hydrate from persisted snapshot
    try {
      const resolvedSnapshot = machine.resolveState(stateSnapshot);
      actor = createActor(machine, { snapshot: resolvedSnapshot });
    } catch {
      actor = createActor(machine);
    }
  } else if (initialContext && Object.keys(initialContext).length > 0) {
    // New actor with initial context — seed via resolved snapshot so XState holds it
    try {
      const initialValue = typeof definitionJson.initial === 'string'
        ? definitionJson.initial
        : (definitionJson.initial?.target ?? Object.keys(definitionJson.states ?? {})[0]);
      const snap = machine.resolveState({ value: initialValue, context: initialContext });
      actor = createActor(machine, { snapshot: snap });
    } catch {
      actor = createActor(machine);
    }
  } else {
    actor = createActor(machine);
  }

  actor.start();
  actors.set(actorId, { actor, machine, definitionJson });

  const snapshot = actor.getSnapshot();
  return {
    ...serializeSnapshot(snapshot, actorId),
    regionFingerprints: initializeRegionFingerprints(
      definitionJson,
      snapshot.value,
      existingRegionFingerprints ?? null
    ),
  };
}

function handleEvent({ actorId, event, historyFingerprint, regionFingerprints }) {
  const entry = actors.get(actorId);
  if (!entry) throw new Error(`Actor ${actorId} not in worker`);

  const { actor, definitionJson } = entry;

  // Capture pre-event state for per-region diff (parallel machines only)
  const preSV = actor.getSnapshot().value;

  actor.send(event);

  const snapshot       = actor.getSnapshot();
  const newFingerprint = updateFingerprint(historyFingerprint, event.type);

  const newRegionFingerprints = updateRegionFingerprintsForTransition(
    definitionJson,
    preSV,
    snapshot.value,
    event.type,
    regionFingerprints ?? null
  );

  return {
    ...serializeSnapshot(snapshot, actorId),
    historyFingerprint: newFingerprint,
    regionFingerprints: newRegionFingerprints,
  };
}

/**
 * Resolve where an actor should land in the new machine.
 *
 * For flat machines: returns the landing state name (string).
 * For compound/parallel machines: returns the full compound state value object
 *   when the top-level key exists in newMachineStates, so XState can restore
 *   the full sub-state via resolveState({ value: landingState }).
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

  // Compound or parallel state value object
  if (currentStateValue && typeof currentStateValue === 'object') {
    const topLevel = Object.keys(currentStateValue)[0];
    if (!topLevel) return null;
    const mappedKey = stateMapping[topLevel];
    if (mappedKey) {
      // Explicit override: land at mapped state (flat string)
      return newMachineStates[mappedKey] ? mappedKey : null;
    }
    // Top-level key exists in new machine: return full compound value so
    // XState restores the complete sub-state hierarchy via resolveState
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
  // Stop existing actor if present
  const existing = actors.get(actorId);
  if (existing) {
    try { existing.actor.stop(); } catch {}
    actors.delete(actorId);
  }

  const machine   = getOrCacheMachine(targetDefinitionId, targetDefinitionJson);
  const newStates = targetDefinitionJson.states ?? {};

  // Apply context transform — errors here must abort migration (INVARIANT 3)
  let transformedContext;
  try {
    transformedContext = applyContextTransform(oldContext ?? {}, contextTransform);
  } catch (err) {
    return { error: 'CONTEXT_TRANSFORM_FAILED', message: err.message };
  }

  // Resolve landing state when we have the actor's current position
  if (currentStateValue != null) {
    const landingState = resolveLandingState(currentStateValue, newStates, stateMapping ?? {});
    if (!landingState) {
      return { error: 'STATE_NOT_MAPPABLE', currentStateValue };
    }

    let actor;
    try {
      const baseSnapshot = machine.resolveState({
        value:   landingState,
        context: transformedContext,
        status:  'active',
      });
      actor = createActor(machine, { snapshot: baseSnapshot });
    } catch {
      actor = createActor(machine, { input: transformedContext });
    }

    actor.start();
    actors.set(actorId, { actor, machine, definitionJson: targetDefinitionJson });
    const snap = serializeSnapshot(actor.getSnapshot(), actorId);
    // INVARIANT 1: fingerprint passes through unchanged — never recomputed from context
    return {
      ...snap,
      historyFingerprint: existingFingerprint ?? null,
      regionFingerprints: initializeRegionFingerprints(
        targetDefinitionJson,
        snap.stateValue,
        existingRegionFingerprints ?? null
      ),
    };
  }

  // Fallback: no current state provided, land at initial (legacy path)
  let actor;
  try {
    const baseSnapshot = machine.resolveState({
      value:   machine.initial,
      context: transformedContext,
      status:  'active',
    });
    actor = createActor(machine, { snapshot: baseSnapshot });
  } catch {
    actor = createActor(machine, { input: transformedContext });
  }

  actor.start();
  actors.set(actorId, { actor, machine, definitionJson: targetDefinitionJson });
  const snap = serializeSnapshot(actor.getSnapshot(), actorId);
  return {
    ...snap,
    historyFingerprint: existingFingerprint ?? null,
    regionFingerprints: initializeRegionFingerprints(
      targetDefinitionJson,
      snap.stateValue,
      existingRegionFingerprints ?? null
    ),
  };
}

function handleSnapshot({ actorId }) {
  const entry = actors.get(actorId);
  if (!entry) return null;
  return serializeSnapshot(entry.actor.getSnapshot(), actorId);
}

function handleTerminate({ actorId }) {
  const entry = actors.get(actorId);
  if (!entry) return null;
  const snap = serializeSnapshot(entry.actor.getSnapshot(), actorId);
  try { entry.actor.stop(); } catch {}
  actors.delete(actorId);
  return snap;
}

// ── Serialization ─────────────────────────────────────────────────────────────

function serializeSnapshot(snapshot, actorId) {
  return {
    actorId,
    stateValue: snapshot.value,
    context:    snapshot.context ?? null,
    status:     snapshot.status,
    done:       snapshot.status === 'done',
  };
}

function getSnapshot(actorId) {
  const entry = actors.get(actorId);
  if (!entry) return null;
  return serializeSnapshot(entry.actor.getSnapshot(), actorId);
}

// ── Message dispatch ──────────────────────────────────────────────────────────

/* Guard: parentPort is null when the file is imported outside a worker context
 * (e.g. in unit tests importing resolveLandingState directly). */
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
      case 'BATCH_EVENTS': {
        // Chain fingerprints across events so each one builds on the previous result.
        // Ignore the per-event historyFingerprint sent by the pool (may be stale when
        // multiple requests were in-flight simultaneously) — use the running value instead.
        const results = [];
        let fp  = msg.events[0]?.historyFingerprint  ?? '0';
        let rfp = msg.events[0]?.regionFingerprints  ?? null;
        for (const evData of msg.events) {
          const r = handleEvent({ actorId: msg.actorId, event: evData.event, historyFingerprint: fp, regionFingerprints: rfp });
          results.push(r);
          fp  = r.historyFingerprint;
          rfp = r.regionFingerprints;
        }
        result = { results };
        break;
      }
      default:          error  = `Unknown message type: ${type}`;
    }
  } catch (err) {
    error = err.message;
  }

  parentPort.postMessage({ id, ok: !error, result, error });
});

// Signal readiness (only when running as a real worker)
if (parentPort) parentPort.postMessage({ id: '__ready__', ok: true });
