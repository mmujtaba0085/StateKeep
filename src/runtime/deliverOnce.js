/**
 * src/runtime/deliverOnce.js — deliver an event to an actor at most once per key.
 *
 * Used for events produced by the system (an action's follow-up event, a human's
 * resolution). The event row is written with `idempotency_key = key` in the same
 * commit as the actor's new state, so after a crash we can tell whether it already
 * happened. Must run on the server that owns the actor (the worker and the internal
 * dispatch route do; in cluster mode requests are routed to the owner).
 */
import { sendEvent } from './actorManager.js';
import { getWriteBuffer } from './writeBuffer.js';
import { getDb, isPostgres, encrypt } from '../registry/db.js';
import { getEngine } from '../ffi/engine.js';

const inFlight = new Map();   // `${actorId}:${key}` → promise

async function alreadyDelivered(actorId, key) {
  if (getWriteBuffer().hasPendingEvent(actorId, key)) return true;
  if (isPostgres) {
    const { queryOne } = await import('../registry/db-postgres.js');
    return !!(await queryOne('SELECT 1 AS x FROM events WHERE actor_id=$1 AND idempotency_key=$2', [actorId, key]));
  }
  return !!getDb().prepare('SELECT 1 FROM events WHERE actor_id=? AND idempotency_key=?').get(actorId, key);
}

/**
 * @returns {Promise<{ duplicate: boolean, result?: object }>}
 */
export async function deliverEventOnce(actorId, event, key, { mergePayload = event } = {}) {
  const k = `${actorId}:${key}`;
  while (inFlight.has(k)) await inFlight.get(k).catch(() => {});
  let release;
  inFlight.set(k, new Promise((r) => { release = r; }));
  try {
    if (await alreadyDelivered(actorId, key)) return { duplicate: true };
    const eng  = getEngine();
    const tick = eng.available ? Number(eng.clockTick()) : Date.now();
    const { type, ...payload } = event;
    const result = await sendEvent(actorId, event, tick, {
      mergePayload,
      eventData: {
        actor_id:        actorId,
        event_type:      type,
        event_payload:   Object.keys(payload).length ? encrypt(Buffer.from(JSON.stringify(payload))) : null,
        tick,
        processed_at:    Date.now(),
        idempotency_key: key,
      },
    });
    return { duplicate: false, result };
  } finally {
    inFlight.delete(k);
    release();
  }
}
