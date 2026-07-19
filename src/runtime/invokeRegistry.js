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
/**
 * Start an invoke and register it globally.
 * actorData:   { context, event } — actor's current context and the triggering event.
 * sendEventFn: async (actorId, event) => void   (bound actorManager.sendEvent)
 */
export async function startInvoke(actorId, invokeId, serviceFn, opts, actorData, sendEventFn) {
  const { idempotent = false, timeout = 30_000 } = opts ?? {};
  const { context: actorContext = {}, event: triggerEvent = {} } = actorData ?? {};
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

    Promise.resolve(serviceFn({ context: actorContext, event: triggerEvent }, {}))
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
        // Bug 1: Mark original row closed so it isn't replayed on next restart
        await markInvokeFailed(row.id).catch(() => {});
        // Bug 3: Unwrap decorator — mirrors actorManager pattern
        const invokeFn = serviceFn.__sk_invoke ? serviceFn.__sk_invoke.originalFn : serviceFn;
        const recOpts  = {
          idempotent: true,
          timeout:    row.timeout_at - Date.now(),
          ...(serviceFn.__sk_invoke ?? {}),
        };
        // Re-run idempotent invoke with remaining timeout
        await startInvoke(row.actor_id, row.invoke_id, invokeFn, recOpts, {}, sendEventFn).catch(() => {});
      } else {
        // Bug 2: Fire error event and mark failed when serviceFn not found in registry
        console.warn(`[invokeRegistry] recovery: service '${row.service_id}' not found in registry — marking failed`);
        await sendEventFn(row.actor_id, {
          type: `error.invoke.${row.service_id}`,
          data: new Error(`Service '${row.service_id}' not found in registry during recovery`)
        }).catch(() => {});
        await markInvokeFailed(row.id).catch(() => {});
      }
    } else {
      await sendEventFn(row.actor_id, { type: `error.invoke.${row.service_id}`, data: new Error('Non-idempotent invoke did not complete before restart') }).catch(() => {});
      await markInvokeFailed(row.id).catch(() => {});
    }
  }
}
