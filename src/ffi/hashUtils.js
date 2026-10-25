/**
 * src/ffi/hashUtils.js
 *
 * Two hashing surfaces — do not confuse them:
 *
 *   computeHash(items)       — one-shot WASM FNV-1a, used for prefix_hash / region fingerprints
 *   computeHistoryHash(evts) — pure-JS chain matching actorWorker's incremental updateFingerprint
 *
 * Both produce 64-bit FNV-1a values as 16-char lowercase hex strings.
 */

import { getEngine } from './engine.js';
import {
  FNV64_OFFSET,
  computeHistoryFingerprint,
  updateFingerprint as updateFingerprintPure,
  engineKey, isLegacy, isEmpty, regionKeyV2,
} from './fingerprintChain.js';

export { FNV64_OFFSET };
export { FNV64_OFFSET as FNV_OFFSET };

// ── computeHash — generic one-shot hash ──────────────────────────────────────

/**
 * Compute a FNV-1a hash over an array of string/Buffer items.
 * Calls fnv1aFinal once at the end.
 * Returns a 16-char lowercase hex string.
 */
export function computeHash(items) {
  const eng = getEngine();
  let h = eng.fnv1aInit();
  for (const item of items) {
    const buf = Buffer.isBuffer(item) ? item : Buffer.from(String(item), 'utf8');
    h = eng.fnv1aUpdate(h, buf);
  }
  h = eng.fnv1aFinal(h);
  return bigIntToHex(h);
}

// ── computeHistoryHash — mirrors actorWorker incremental fingerprint ──────────

/**
 * Compute the fingerprint that an actor would have after processing
 * `eventTypes` in sequence, starting from the '0' initial sentinel.
 * Returns a 16-char lowercase hex string (FNV-1a 64-bit).
 */
export function computeHistoryHash(eventTypes, scheme = 2) {
  return computeHistoryFingerprint(eventTypes, scheme);
}

// ── updateFingerprint — incremental, for non-worker callers ──────────────────

/** Update an existing fingerprint hex string with one new event type. */
export function updateFingerprint(currentHex, eventType, hint = 2) {
  return updateFingerprintPure(currentHex, eventType, hint);
}

// ── Conversion helpers ────────────────────────────────────────────────────────

/**
 * Convert a BigInt hash value to a 16-char lowercase hex string.
 */
export function bigIntToHex(bi) {
  if (typeof bi === 'bigint') {
    return (bi & 0xFFFFFFFFFFFFFFFFn).toString(16).padStart(16, '0');
  }
  return (bi >>> 0).toString(16).padStart(16, '0');
}

/**
 * Convert a stored fingerprint hex string to BigInt for engine calls.
 * The '0' sentinel means "no events processed" (hexToBigInt maps it to the wildcard 0n).
 *
 * Use hexToBigInt when you want 0n as an explicit wildcard (e.g. for
 * apv_register_changepoint when no historyPath is provided).
 *
 * Use fingerprintToBigInt when passing an actor's historyFingerprint to a scalar
 * lookup. It is never 0n, because scalar key 0 is the engine's wildcard
 * (see engineKey in fingerprintChain.js and the "Keys" note in docs/apv.md §8).
 */
export function hexToBigInt(hex) {
  if (!hex || hex === '0') return 0n;
  return BigInt(`0x${hex.padStart(16, '0')}`);
}

/** An actor's fingerprint (either scheme, or '0') as its 64-bit engine key (never 0). */
export function fingerprintToBigInt(fp) {
  return engineKey(fp);
}

// ── Parallel (per-region) hash helpers ───────────────────────────────────────

/**
 * Compute per-region history hashes from a map of { regionName: [eventType, ...] }.
 * Returns { regionName: hexFingerprint } using the same chain as computeHistoryHash.
 */
export function computeRegionHashes(eventsByRegion, scheme = 2) {
  const result = {};
  for (const [region, events] of Object.entries(eventsByRegion).sort(([a], [b]) => a.localeCompare(b))) {
    result[region] = computeHistoryHash(events, scheme);
  }
  return result;
}

function normalizeRegionFingerprintHex(hex) {
  if (!hex || hex === '0') return bigIntToHex(FNV64_OFFSET);
  return String(hex).padStart(16, '0').toLowerCase();
}

/**
 * Encode a full region path plus that region's event fingerprint into one
 * uint64. The C ABI still receives uint64_t values, but the value now carries
 * both region identity and region event history.
 */
export function encodeRegionFingerprint(regionPath, regionFingerprintHex) {
  return computeHash([
    'statekeep.region.v1',
    '\0',
    regionPath,
    '\0',
    normalizeRegionFingerprintHex(regionFingerprintHex),
  ]);
}

/**
 * Convert a regionFingerprints map ({ regionPath: hexFp }) to an array of BigInts
 * suitable for passing to eng.registerChangepointParallel / eng.computeAccessibleParallel.
 * Returns null if the map is empty or null.
 */
export function regionFingerprintsToArray(regionFingerprintsHex, scheme = null) {
  if (!regionFingerprintsHex) return null;
  const entries = Object.entries(regionFingerprintsHex).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  // One scheme per actor: legacy if any region carries a legacy fingerprint.
  const s = scheme ?? (entries.some(([, v]) => isLegacy(v)) ? 1 : 2);
  return entries.map(([regionPath, fp]) => regionKeyCached(s, regionPath, fp));
}

// Region keys are pure functions of (scheme, path, fingerprint) and are recomputed at every
// routing decision of a parallel actor: memoize them (bounded).
const _regionKeyMemo = new Map();
function regionKeyCached(s, regionPath, fp) {
  const k = `${s}|${regionPath}|${fp}`;
  let v = _regionKeyMemo.get(k);
  if (v === undefined) {
    v = s === 1
      ? hexToBigInt(encodeRegionFingerprint(regionPath, isEmpty(fp) ? '0' : fp))
      : regionKeyV2(regionPath, fp);
    if (_regionKeyMemo.size >= 50_000) _regionKeyMemo.clear();
    _regionKeyMemo.set(k, v);
  }
  return v;
}
