// src/runtime/invokeRegistry.js
//
// Global singleton Map of in-flight invoke Promises.
// Lives independently of the hot registry LRU — invoke Promises continue
// running after an actor is evicted, and survive server restarts via DB.

import { randomUUID } from 'crypto';
import { insertRunningInvoke, markInvokeDone, markInvokeFailed } from '../registry/invokeRepo.js';

// "actorId:invokeId" → { promise, cancel, timeoutHandle, dbRowId }
const _registry = new Map();

/**
 * Start an invoke and register it globally.
 * sendEventFn: async (actorId, event) => void   (bound actorManager.sendEvent)
 */
export async function startInvoke(actorId, invokeId, serviceFn, opts, sendEventFn) {
  const { idempotent = false, timeout = 30_000 } = opts ?? {};
  const serviceId     = invokeId;
  const dbRowId       = randomUUID();
  const correlationId = randomUUID();
  const startedAt     = Date.now();
  const timeoutAt     = startedAt + timeout;
  const key           = `${actorId}:${invokeId}`;

  // Persist to DB for restart recovery
  await insertRunningInvoke({ id: dbRowId, actorId, invokeId, serviceId, startedAt, timeoutAt, correlationId, idempotent });

  let timeoutHandle;
  let cancelled = false;

  const promise = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      cancelled = true;
      reject(new Error(`Invoke '${invokeId}' timed out after ${timeout}ms`));
    }, timeout);

    const context = {}; // filled at invoke time from hot registry if available
    Promise.resolve(serviceFn({ context, event: {} }, {}))
      .then(resolve, reject);
  });

  const handle = {
    promise,
    cancel: () => { cancelled = true; clearTimeout(timeoutHandle); },
    dbRowId,
  };
  _registry.set(key, handle);

  promise
    .then(async (data) => {
      clearTimeout(timeoutHandle);
      if (!cancelled) {
        await markInvokeDone(dbRowId).catch(() => {});
        await sendEventFn(actorId, { type: `done.invoke.${serviceId}`, data }).catch(() => {});
      }
    })
    .catch(async (err) => {
      clearTimeout(timeoutHandle);
      if (!cancelled) {
        await markInvokeFailed(dbRowId).catch(() => {});
        await sendEventFn(actorId, { type: `error.invoke.${serviceId}`, data: err }).catch(() => {});
      }
    })
    .finally(() => _registry.delete(key));
}

/** Called during LRU eviction — Promises continue running detached. */
export function detachActorInvokes(actorId) {
  // Handles remain in _registry and in Node.js event loop — nothing to do here.
  // Called to make the detach intent explicit in the eviction path.
}

/** Returns true if the actor has in-flight invokes (used to skip LRU eviction). */
export function hasActiveInvokes(actorId) {
  for (const key of _registry.keys()) {
    if (key.startsWith(`${actorId}:`)) return true;
  }
  return false;
}

/**
 * Restart recovery: re-run idempotent invokes, fire error event for non-idempotent.
 */
export async function recoverInvokes(rows, sendEventFn, implRegistry) {
  for (const row of rows) {
    if (Date.now() > row.timeout_at) {
      // Stale — fire error
      await sendEventFn(row.actor_id, { type: `error.invoke.${row.service_id}`, data: new Error('Invoke timed out before recovery') }).catch(() => {});
      await markInvokeFailed(row.id).catch(() => {});
      continue;
    }
    if (row.idempotent) {
      const serviceFn = implRegistry?.services?.[row.service_id];
      if (serviceFn) {
        await startInvoke(row.actor_id, row.invoke_id, serviceFn, { idempotent: true, timeout: row.timeout_at - Date.now() }, sendEventFn).catch(() => {});
      }
    } else {
      await sendEventFn(row.actor_id, { type: `error.invoke.${row.service_id}`, data: new Error('Non-idempotent invoke did not complete before restart') }).catch(() => {});
      await markInvokeFailed(row.id).catch(() => {});
    }
  }
}
