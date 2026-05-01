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

// ── Actor store ───────────────────────────────────────────────────────────────

/** Map<actorId, { actor, machine }> */
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

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleSpawn({ actorId, definitionJson, stateSnapshot, initialContext }) {
  if (actors.has(actorId)) return getSnapshot(actorId);

  const machine = createMachine(definitionJson).provide({ guards: buildDefaultGuards(definitionJson) });
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
  actors.set(actorId, { actor, machine });

  return serializeSnapshot(actor.getSnapshot(), actorId);
}

function handleEvent({ actorId, event, historyFingerprint }) {
  const entry = actors.get(actorId);
  if (!entry) throw new Error(`Actor ${actorId} not in worker`);

  const { actor } = entry;
  actor.send(event);

  const snapshot      = actor.getSnapshot();
  const newFingerprint = updateFingerprint(historyFingerprint, event.type);

  return {
    ...serializeSnapshot(snapshot, actorId),
    historyFingerprint: newFingerprint,
  };
}

/**
 * Resolve where an actor should land in the new machine.
 * Returns the landing state name, or null if it cannot be resolved (needs_rescue).
 * Exported so it can be unit-tested without a running server.
 */
export function resolveLandingState(currentStateValue, newMachineStates, stateMapping = {}) {
  const topLevel = typeof currentStateValue === 'string'
    ? currentStateValue
    : Object.keys(currentStateValue ?? {})[0];
  if (!topLevel) return null;
  if (newMachineStates[topLevel]) return topLevel;
  const mapped = stateMapping[topLevel];
  if (mapped && newMachineStates[mapped]) return mapped;
  return null;
}

function handleHydrate({ actorId, targetDefinitionJson, oldContext, currentStateValue, stateMapping }) {
  // Stop existing actor if present
  const existing = actors.get(actorId);
  if (existing) {
    try { existing.actor.stop(); } catch {}
    actors.delete(actorId);
  }

  const machine    = createMachine(targetDefinitionJson).provide({ guards: buildDefaultGuards(targetDefinitionJson) });
  const newStates  = targetDefinitionJson.states ?? {};

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
        context: oldContext ?? {},
        status:  'active',
      });
      actor = createActor(machine, { snapshot: baseSnapshot });
    } catch {
      actor = createActor(machine, { input: oldContext });
    }

    actor.start();
    actors.set(actorId, { actor, machine });
    return serializeSnapshot(actor.getSnapshot(), actorId);
  }

  // Fallback: no current state provided, land at initial (legacy path)
  let actor;
  try {
    const baseSnapshot = machine.resolveState({
      value:   machine.initial,
      context: oldContext ?? {},
      status:  'active',
    });
    actor = createActor(machine, { snapshot: baseSnapshot });
  } catch {
    actor = createActor(machine, { input: oldContext });
  }

  actor.start();
  actors.set(actorId, { actor, machine });
  return serializeSnapshot(actor.getSnapshot(), actorId);
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

parentPort.on('message', (msg) => {
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
      default:          error  = `Unknown message type: ${type}`;
    }
  } catch (err) {
    error = err.message;
  }

  parentPort.postMessage({ id, ok: !error, result, error });
});

// Signal readiness
parentPort.postMessage({ id: '__ready__', ok: true });
