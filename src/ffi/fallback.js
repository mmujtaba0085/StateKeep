/**
 * src/ffi/fallback.js
 *
 * No-op fallback used when libapv-engine.so is missing.
 * All functions return safe defaults:
 *   - computeAccessible() returns null → "stay put"
 *   - clockTick()          returns monotonically incrementing counter
 *   - All notifications are no-ops
 */

let _tick = 1n;

export const engine = {
  available: false,

  /** Returns a new logical tick (BigInt). */
  clockTick() {
    return _tick++;
  },

  /**
   * Register a changepoint. No-op in fallback mode.
   * @returns {number} 0 (success)
   */
  registerChangepoint(_tStar, _prefixHash, _refinement, _childDefId) {
    return 0;
  },

  /**
   * Compute migration target.
   * @returns {null} — always "stay put"
   */
  computeAccessible(_prefixHash, _actorLogicalTime, _currentTime) {
    return null;
  },

  actorStarted(_tStar, _prefixHash) {},
  actorStopped(_tStar, _prefixHash) {},
  vacatePrefix(_tStar, _prefixHash) {},

  /** FNV-1a init — returns the standard offset basis as BigInt */
  fnv1aInit() {
    return 0xcbf29ce484222325n;
  },

  /** FNV-1a update — pure JS implementation, consistent with C version */
  fnv1aUpdate(hash, data) {
    const FNV_PRIME  = 0x00000100000001B3n;
    const UINT64_MAX = 0xFFFFFFFFFFFFFFFFn;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    for (const byte of buf) {
      hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & UINT64_MAX;
    }
    return hash;
  },

  fnv1aFinal(hash) {
    return hash;
  },

  destroy() {},
};

export default engine;
