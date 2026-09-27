/**
 * src/cluster/cluster.js — run several API servers against one Postgres database.
 *
 * Why this is needed: each server keeps actors in an in-memory hot cache and writes
 * them back. Two servers writing the same actor would overwrite each other (the same
 * class of bug as the scheduler one fixed earlier). So every actor has exactly ONE
 * owning server at a time:
 *
 *   - Ownership is a row in actor_owners. The first server to touch an actor claims it.
 *   - Any server accepts any request. Requests for an actor owned elsewhere are
 *     forwarded to the owner (one hop; forwarded requests are never re-forwarded).
 *   - Servers heartbeat into cluster_nodes. If an owner's heartbeat is older than
 *     STATEKEEP_NODE_TTL_MS (or forwarding to it fails and it has expired), another
 *     server takes the actor over, drops any stale cached copy and reloads it from the
 *     database — safe because every acknowledged event is already committed.
 *   - Before handling an actor locally, a server confirms (cheap indexed read) that it
 *     is still the owner, so a server that was paused and "declared dead" can't write
 *     with a stale cache.
 *   - State-change notifications fan out with Postgres LISTEN/NOTIFY so WebSocket
 *     subscribers connected to any server receive them.
 *
 * Enable: STATEKEEP_CLUSTER=true, STATEKEEP_DB_URL=postgres://…, STATEKEEP_NODE_URL=
 * http://<this-server>:<port> (reachable by the other servers), STATEKEEP_ADMIN_KEY set.
 */
import { randomUUID } from 'crypto';
import { evictFromHotRegistry } from '../runtime/actorManager.js';

export const clusterEnabled = () => process.env.STATEKEEP_CLUSTER === 'true';
const TTL_MS       = () => parseInt(process.env.STATEKEEP_NODE_TTL_MS ?? '5000', 10);
const HEARTBEAT_MS = () => Math.max(200, Math.floor(TTL_MS() / 4));
export const NODE_ID = process.env.STATEKEEP_NODE_ID ?? `node-${randomUUID().slice(0, 8)}`;
const FORWARD_HEADER = 'x-statekeep-forwarded-by';
const FORWARDED_HEADERS = ['content-type', 'x-api-key', 'x-admin-key', 'x-priority', 'x-request-id'];

let pg = null;           // db-postgres module
let myUrl = null;
let heartbeatTimer = null;

export function checkClusterConfig(env = process.env) {
  if (env.STATEKEEP_CLUSTER !== 'true') return null;
  if (!(env.STATEKEEP_DB_URL ?? '').startsWith('postgres')) return 'STATEKEEP_CLUSTER=true requires Postgres (STATEKEEP_DB_URL).';
  if (!env.STATEKEEP_NODE_URL) return 'STATEKEEP_CLUSTER=true requires STATEKEEP_NODE_URL (how other servers reach this one).';
  if (!env.STATEKEEP_ADMIN_KEY) return 'STATEKEEP_CLUSTER=true requires STATEKEEP_ADMIN_KEY (servers call each other\'s internal routes).';
  return null;
}

async function heartbeat() {
  const now = Date.now();
  await pg.query(
    `INSERT INTO cluster_nodes (node_id, url, started_at, last_seen) VALUES ($1,$2,$3,$3)
     ON CONFLICT (node_id) DO UPDATE SET url = EXCLUDED.url, last_seen = EXCLUDED.last_seen`,
    [NODE_ID, myUrl, now]);
}

/** Owner of an actor: { nodeId, url, alive } or null when unowned. */
async function ownerOf(actorId) {
  const row = await pg.queryOne(
    `SELECT o.node_id, n.url, n.last_seen FROM actor_owners o LEFT JOIN cluster_nodes n ON n.node_id = o.node_id WHERE o.actor_id = $1`,
    [actorId]);
  if (!row) return null;
  return { nodeId: row.node_id, url: row.url, alive: row.last_seen != null && Date.now() - Number(row.last_seen) < TTL_MS() };
}

/** Claim an unowned actor, or take it over from `fromNode` (only if that is still the owner). */
async function claim(actorId, fromNode = null) {
  const now = Date.now();
  const row = fromNode
    ? await pg.queryOne(`UPDATE actor_owners SET node_id = $1, claimed_at = $2 WHERE actor_id = $3 AND node_id = $4 RETURNING node_id`,
        [NODE_ID, now, actorId, fromNode])
    : await pg.queryOne(`INSERT INTO actor_owners (actor_id, node_id, claimed_at) VALUES ($1,$2,$3)
                         ON CONFLICT (actor_id) DO NOTHING RETURNING node_id`, [actorId, NODE_ID, now]);
  if (row?.node_id === NODE_ID) {
    evictFromHotRegistry(actorId);          // never serve a copy cached before we (re)gained ownership
    return true;
  }
  return false;
}

/** Record that this server owns a freshly spawned actor. */
export async function claimNew(actorId) {
  if (!clusterEnabled() || !pg) return;
  await pg.query(`INSERT INTO actor_owners (actor_id, node_id, claimed_at) VALUES ($1,$2,$3) ON CONFLICT (actor_id) DO NOTHING`,
    [actorId, NODE_ID, Date.now()]);
}

async function forward(owner, request, reply) {
  const headers = { [FORWARD_HEADER]: NODE_ID };
  for (const h of FORWARDED_HEADERS) if (request.headers[h]) headers[h] = request.headers[h];
  const hasBody = request.body !== undefined && !['GET', 'HEAD', 'DELETE'].includes(request.method);
  if (hasBody) headers['content-type'] = 'application/json';
  const res = await fetch(owner.url.replace(/\/$/, '') + request.url, {
    method: request.method, headers, body: hasBody ? JSON.stringify(request.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  reply.code(res.status).header('x-statekeep-served-by', owner.nodeId);
  const ct = res.headers.get('content-type'); if (ct) reply.header('content-type', ct);
  return reply.send(text);
}

function actorIdFor(request) {
  const route = request.routeOptions?.url ?? '';
  // WebSocket streams are served by any server (changes arrive via LISTEN/NOTIFY);
  // an upgrade request cannot be forwarded over plain HTTP.
  if (route.endsWith('/stream') || request.headers.upgrade) return null;
  if (route.startsWith('/v1/actors/:id') || route.startsWith('/v1/internal/actors/:id')) return request.params?.id ?? null;
  if (route === '/v1/internal/cache/evict') return request.body?.actorId ?? null;
  return null;
}

/** preHandler: route per-actor requests to the owning server. */
async function routeToOwner(request, reply) {
  if (!pg) return;                                // cluster not started yet
  const actorId = actorIdFor(request);
  if (!actorId || actorId === 'needs-rescue') return;
  if (request.headers[FORWARD_HEADER]) {
    // Forwarded to us as the owner. If ownership moved meanwhile, still handle it here
    // (no ping-pong), but make sure we are the owner so the write is fenced.
    const o = await ownerOf(actorId);
    if (!o) await claim(actorId);
    else if (o.nodeId !== NODE_ID) await claim(actorId, o.nodeId);
    reply.header('x-statekeep-served-by', NODE_ID);
    return;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const o = await ownerOf(actorId);
    if (!o) {
      // Unowned: only claim actors that exist (404s are answered by the route itself)
      const exists = await pg.queryOne('SELECT 1 AS x FROM actors WHERE id = $1', [actorId]);
      if (!exists || await claim(actorId)) break;
      continue;
    }
    if (o.nodeId === NODE_ID) break;
    if (o.alive && o.url) {
      try { return await forward(o, request, reply); }
      catch (err) {
        request.log.warn(`[cluster] forward to ${o.nodeId} failed: ${err.message}`);
        const again = await ownerOf(actorId);
        if (again?.alive && again.nodeId === o.nodeId) {
          return reply.code(503).send({ error: `owner ${o.nodeId} unreachable; retry shortly`, code: 'OWNER_UNREACHABLE' });
        }
      }
    }
    // Owner's heartbeat expired → take the actor over and serve it from the database.
    if (await claim(actorId, o.nodeId)) { request.log.info(`[cluster] took over ${actorId} from ${o.nodeId}`); break; }
  }
  reply.header('x-statekeep-served-by', NODE_ID);
}

// ── LISTEN/NOTIFY fan-out for WebSocket subscribers ─────────────────────────
let listener = null;
export async function publishStateChange(actorId, stateValue, context) {
  if (!clusterEnabled() || !pg) return;
  const payload = JSON.stringify({ from: NODE_ID, actorId, stateValue, context });
  if (payload.length > 7900) return;             // NOTIFY payload limit; subscribers re-read state
  await pg.query('SELECT pg_notify($1, $2)', ['statekeep_state', payload]).catch(() => {});
}

/** Register the routing hook — call BEFORE routes are registered. */
export function registerClusterRouting(fastify) {
  if (clusterEnabled()) fastify.addHook('preHandler', routeToOwner);
}

/** Start heartbeats + notifications — call AFTER the schema is bootstrapped. */
export async function startCluster(fastify, { onRemoteStateChange } = {}) {
  if (!clusterEnabled()) return;
  const mod = await import('../registry/db-postgres.js');
  myUrl = process.env.STATEKEEP_NODE_URL;
  pg = mod;
  await heartbeat();
  heartbeatTimer = setInterval(() => heartbeat().catch((e) => fastify.log.error(`[cluster] heartbeat: ${e.message}`)), HEARTBEAT_MS());
  heartbeatTimer.unref();

  const { default: pgLib } = await import('pg');
  let closing = false;
  // The LISTEN connection must survive a dropped database connection: an unhandled
  // 'error' on a pg Client crashed the whole API server.
  const connectListener = async () => {
    const client = new pgLib.Client({ connectionString: process.env.STATEKEEP_DB_URL });
    client.on('error', (err) => {
      fastify.log.warn(`[cluster] LISTEN connection lost: ${err.message} — reconnecting`);
      client.end().catch(() => {});
      if (!closing) setTimeout(() => connectListener().catch(() => {}), 1000).unref();
    });
    client.on('notification', (msg) => {
      try {
        const m = JSON.parse(msg.payload);
        if (m.from !== NODE_ID) onRemoteStateChange?.(m.actorId, m.stateValue, m.context);
      } catch {}
    });
    try {
      await client.connect();
      await client.query('LISTEN statekeep_state');
      listener = client;
    } catch (err) {
      fastify.log.warn(`[cluster] LISTEN connect failed: ${err.message} — retrying`);
      client.end().catch(() => {});
      if (!closing) setTimeout(() => connectListener().catch(() => {}), 1000).unref();
    }
  };
  await connectListener();
  fastify.addHook('onClose', async () => { closing = true; clearInterval(heartbeatTimer); await listener?.end().catch(() => {}); });
  fastify.log.info(`[cluster] node ${NODE_ID} at ${myUrl} (ttl ${TTL_MS()}ms)`);
}
