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
  bigIntToHex64,
  computeHistoryFingerprint,
  updateFingerprint as updateFingerprintPure,
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
export function computeHistoryHash(eventTypes) {
  return computeHistoryFingerprint(eventTypes);
}

// ── updateFingerprint — incremental, for non-worker callers ──────────────────

/** Update an existing fingerprint hex string with one new event type. */
export function updateFingerprint(currentHex, eventType) {
  return updateFingerprintPure(currentHex, eventType);
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
 * The '0' sentinel means "no events processed" and maps to FNV64_OFFSET.
 *
 * Use hexToBigInt when you want 0n as an explicit wildcard (e.g. for
 * apv_register_changepoint when no historyPath is provided).
 *
 * Use fingerprintToBigInt when passing an actor's historyFingerprint
 * to apv_compute_accessible or apv_actor_started — '0' must map to
 * FNV64_OFFSET because 0n == APV_PREFIX_WILDCARD.
 */
export function hexToBigInt(hex) {
  if (!hex || hex === '0') return 0n;
  return BigInt(`0x${hex.padStart(16, '0')}`);
}

/** Convert actor historyFingerprint hex to BigInt for engine calls. */
export function fingerprintToBigInt(hex) {
  if (!hex || hex === '0') return FNV64_OFFSET;
  return BigInt(`0x${hex.padStart(16, '0')}`);
}

// ── Parallel (per-region) hash helpers ───────────────────────────────────────

/**
 * Compute per-region history hashes from a map of { regionName: [eventType, ...] }.
 * Returns { regionName: hexFingerprint } using the same chain as computeHistoryHash.
 */
export function computeRegionHashes(eventsByRegion) {
  const result = {};
  for (const [region, events] of Object.entries(eventsByRegion).sort(([a], [b]) => a.localeCompare(b))) {
    result[region] = computeHistoryHash(events);
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
export function regionFingerprintsToArray(regionFingerprintsHex) {
  if (!regionFingerprintsHex) return null;
  const entries = Object.entries(regionFingerprintsHex).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  return entries.map(([regionPath, hex]) => hexToBigInt(encodeRegionFingerprint(regionPath, hex)));
}
