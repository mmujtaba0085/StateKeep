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

// Map<actorId, Set<WebSocket>>
const subscribers = new Map();

/**
 * Notify all WebSocket subscribers about a state change.
 * Called by actorManager after every successful event dispatch.
 */
export function notifyStateChange(actorId, stateValue, context) {
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

    // Verify actor exists and belongs to requesting org
    const actor = await findActorById(actorId);
    if (!actor) {
      socket.send(JSON.stringify({ type: 'ERROR', message: `Actor ${actorId} not found` }));
      socket.close(4004, 'Actor not found');
      return;
    }

    // Register subscriber
    if (!subscribers.has(actorId)) subscribers.set(actorId, new Set());
    subscribers.get(actorId).add(socket);
    request.log.info(`[ws] Client subscribed to actor ${actorId}`);

    // Send current state immediately
    try {
      const state = await getActorState(actorId);
      socket.send(JSON.stringify({ type: 'STATE', ...state, timestamp: new Date().toISOString() }));
    } catch {}

    // Keepalive
    const ping = setInterval(() => {
      try { socket.send(JSON.stringify({ type: 'PING' })); } catch {}
    }, 30_000);

    socket.on('close', () => {
      clearInterval(ping);
      const subs = subscribers.get(actorId);
      if (subs) {
        subs.delete(socket);
        if (subs.size === 0) subscribers.delete(actorId);
      }
      request.log.info(`[ws] Client unsubscribed from actor ${actorId}`);
    });

    socket.on('error', () => {
      clearInterval(ping);
      const subs = subscribers.get(actorId);
      if (subs) subs.delete(socket);
    });
  });
}
