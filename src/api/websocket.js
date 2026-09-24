/**
 * src/api/websocket.js
 *
 * WebSocket endpoint: GET /v1/actors/:id/stream
 * Streams actor state change events to connected clients.
 *
 * Clients send: { type: 'SUBSCRIBE' }
 * Server sends:  { type: 'STATE', actorId, stateValue, context, timestamp }
 *                { type: 'ERROR', message }
 *                { type: 'PING' }  (every 30s keepalive)
 */

import { getActorState } from '../runtime/actorManager.js';
import { findActorById } from '../registry/actorRepo.js';
import { publishStateChange } from '../cluster/cluster.js';

// Map<actorId, Set<WebSocket>>
const subscribers = new Map();

/**
 * Notify all WebSocket subscribers about a state change.
 * Called by actorManager after every successful event dispatch.
 */
/** Local subscribers + (cluster mode) every other server via LISTEN/NOTIFY. */
export function notifyStateChange(actorId, stateValue, context) {
  notifyLocalSubscribers(actorId, stateValue, context);
  publishStateChange(actorId, stateValue, context);
}

export function notifyLocalSubscribers(actorId, stateValue, context) {
  const subs = subscribers.get(actorId);
  if (!subs || subs.size === 0) return;

  const msg = JSON.stringify({
    type:       'STATE',
    actorId,
    stateValue,
    context,
    timestamp:  new Date().toISOString(),
  });

  for (const ws of subs) {
    try { ws.send(msg); } catch {}
  }
}

export async function websocketRoutes(fastify) {
  fastify.get('/v1/actors/:id/stream', { websocket: true }, async (socket, request) => {
    const actorId = request.params.id;
    let ping = null;
    let closed = false;
    const unsubscribe = () => {
      closed = true;
      if (ping) clearInterval(ping);
      const subs = subscribers.get(actorId);
      if (subs) {
        subs.delete(socket);
        if (subs.size === 0) subscribers.delete(actorId);
      }
    };
    // Register before any await: a client that disconnects during the lookup must
    // not leave a dead socket (and its ping timer) in the subscriber map forever.
    socket.on('close', () => {
      unsubscribe();
      request.log.info(`[ws] Client unsubscribed from actor ${actorId}`);
    });

    const actor = await findActorById(actorId);
    if (closed) return;
    if (!actor) {
      socket.send(JSON.stringify({ type: 'ERROR', message: `Actor ${actorId} not found` }));
      socket.close(4004, 'Actor not found');
      return;
    }

    if (!subscribers.has(actorId)) subscribers.set(actorId, new Set());
    subscribers.get(actorId).add(socket);
    request.log.info(`[ws] Client subscribed to actor ${actorId}`);

    try {
      const state = await getActorState(actorId);
      if (!closed) socket.send(JSON.stringify({ type: 'STATE', ...state, timestamp: new Date().toISOString() }));
    } catch {}

    ping = setInterval(() => {
      try { socket.send(JSON.stringify({ type: 'PING' })); } catch {}
    }, 30_000);
    if (closed) unsubscribe();

    socket.on('error', unsubscribe);
  });
}
