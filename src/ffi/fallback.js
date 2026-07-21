/**
 * src/ffi/fallback.js
 *
 * No-op fallback used when libapv-engine.so is missing.
 * All functions return safe defaults:
 *   - computeAccessible() returns null → "stay put"
 *   - clockTick()          returns monotonically incrementing counter
 *   - All notifications are no-ops
 *
 * FNV-1a uses 32-bit Math.imul (same as fingerprintChain.js) instead of
 * BigInt, keeping the fallback path on the native CPU integer path.
 */

const FNV32_PRIME  = 0x01000193;
const FNV32_OFFSET = 0x811c9dc5;

let _tick = 1;

export const engine = {
  available: false,

  /** Returns a new logical tick (plain number). */
  clockTick() {
    return _tick++;
  },

  /**
   * Advance the fallback tick counter to at least `from + 1`.
   * Called at server startup so new deployments get t_star values
   * strictly greater than all historical changepoints stored in the DB.
   */
  seedTick(from) {
    const target = Number(from) + 1;
    if (target > _tick) _tick = target;
  },

  /** Register a changepoint. No-op in fallback mode. */
  registerChangepoint(_tStar, _prefixHash, _refinement, _childDefId) {
    return 0;
  },

  /** Compute migration target. Always "stay put" in fallback mode. */
  computeAccessible(_prefixHash, _actorLogicalTime, _currentTime) {
    return null;
  },

  actorStarted(_tStar, _prefixHash) {},
  actorStopped(_tStar, _prefixHash) {},
  vacatePrefix(_tStar, _prefixHash) {},

  registerChangepointParallel(_tStar, _regionHashes, _refinement, _childDefId) {
    return 0;
  },

  computeAccessibleParallel(_regionHashes, _actorLogicalTime, _currentTime) {
    return null;
  },

  /** FNV-1a init — returns the 32-bit offset basis. */
  fnv1aInit() {
    return FNV32_OFFSET;
  },

  /** FNV-1a update — 32-bit Math.imul, consistent with fingerprintChain.js */
  fnv1aUpdate(hash, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    let h = hash;
    for (const byte of buf) {
      h = Math.imul(h ^ byte, FNV32_PRIME) >>> 0;
    }
    return h;
  },

  fnv1aFinal(hash) {
    return hash >>> 0;
  },

  destroy() {},
};

export default engine;
