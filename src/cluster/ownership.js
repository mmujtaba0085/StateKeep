/**
 * src/cluster/ownership.js — ownership generations (fencing tokens) for cluster mode.
 *
 * Every claim or takeover of an actor increments actor_owners.gen. A server remembers the
 * generation it holds for each actor it owns, and every write it makes for that actor
 * through the write buffer carries that generation. The flush locks the actors'
 * ownership rows (FOR SHARE) and commits only the writes whose generation is still the
 * current one held by this server; the others are dropped and their units answer
 * 503 OWNER_CHANGED instead of 200.
 *
 * A takeover (UPDATE … SET gen = gen + 1) waits for any flush holding those locks, so the
 * new owner always loads a state that includes every write the old owner committed, and
 * the old owner can never commit after the takeover — however long it was paused, and
 * whatever its clock says. Liveness (who may take over) still uses heartbeats on the
 * database clock; safety does not depend on any clock.
 */

const owned  = new Map();   // actorId → generation this server holds
const fenced = new Map();   // actorId → highest generation whose writes were refused
const listeners = [];

/** Cluster mode, unless a test disabled the fence to prove it detects its absence. */
export function ownerFenceEnabled() {
  if (process.env.STATEKEEP_CLUSTER !== 'true') return false;
  return !(process.env.NODE_ENV === 'test' && process.env.STATEKEEP_TEST_DISABLE_OWNER_FENCE === '1');
}

export function setOwnedGen(actorId, gen) { owned.set(actorId, Number(gen)); }
export function ownedGen(actorId) { return owned.get(actorId) ?? null; }
export function forgetOwned(actorId) { owned.delete(actorId); }

/** Called by the write buffer when writes made under `gen` were refused. */
export function markFenced(actorId, gen) {
  if ((fenced.get(actorId) ?? -1) < gen) fenced.set(actorId, gen);
  if (owned.get(actorId) === gen) owned.delete(actorId);
  for (const fn of listeners) { try { fn(actorId, gen); } catch {} }
}

/** Were writes made under `gen` for this actor refused? (null gen: not fenced, i.e. not cluster.) */
export function wasFenced(actorId, gen) {
  return gen != null && (fenced.get(actorId) ?? -1) >= gen;
}

/**
 * (cluster) Lock the ownership rows of these writes (FOR SHARE, until commit) and return
 * the "<actorId>:<gen>" keys whose generation is no longer this server's. Those writes are
 * dropped for good (a newer owner has the actor) and reported through markFenced.
 */
export async function fencedIds(client, keyed) {
  const ids = [...new Set(keyed.map((k) => k.id))];
  const { rows } = await client.query(
    `SELECT actor_id, node_id, gen FROM actor_owners WHERE actor_id = ANY($1) FOR SHARE`, [ids]);
  const cur = new Map(rows.map((r) => [r.actor_id, r]));
  const out = new Set();
  for (const k of keyed) {
    const r = cur.get(k.id);
    if (r && (r.node_id !== process.env.STATEKEEP_NODE_ID || Number(r.gen) !== k.gen)) out.add(`${k.id}:${k.gen}`);
  }
  for (const key of out) {
    const i = key.lastIndexOf(':');
    const id = key.slice(0, i), gen = Number(key.slice(i + 1));
    console.warn(`[writeBuffer] dropped writes for ${id}: ownership moved (generation ${gen} is no longer current)`);
    markFenced(id, gen);
  }
  return out;
}

/**
 * (cluster) Inside a transaction that writes an actor directly (migration, stranding):
 * share-lock its ownership row and throw OWNER_CHANGED if this server's generation is no
 * longer current. No-op outside cluster mode or when this server holds no generation.
 */
export async function assertOwnerInTx(client, actorId) {
  const gen = ownerFenceEnabled() ? ownedGen(actorId) : null;
  if (gen == null) return;
  if ((await fencedIds(client, [{ id: actorId, gen }])).size) throw ownerChangedError(actorId);
}

export function onFenced(fn) { listeners.push(fn); }

export function ownerChangedError(actorId) {
  const err = new Error(`Ownership of actor ${actorId} moved to another server while this request ` +
    `was being processed; the event was not applied. Retry it.`);
  err.code = 'OWNER_CHANGED';
  err.statusCode = 503;
  return err;
}
