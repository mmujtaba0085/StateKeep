/**
 * src/ffi/hashUtils.js
 *
 * FNV-1a 64-bit hash helpers that wrap the engine's apv_fnv1a_* functions
 * (or the JS fallback equivalents).
 *
 * Two hashing surfaces exist here and must NOT be confused:
 *
 *   computeHash(items)
 *     Generic multi-item hash (calls fnv1aFinal once at the end).
 *     Used for computing prefix_hash when historyPath is absent
 *     and for other one-shot hash needs.
 *
 *   computeHistoryHash(eventTypes)
 *     Mirrors exactly what actorWorker.js produces when processing a
 *     sequence of events incrementally.  No per-step fnv1aFinal call —
 *     only a single fnv1aFinal at the end, matching the worker loop.
 *     Used to compute prefix_hash for apv_register_changepoint when
 *     historyPath is provided.
 *
 * Actor fingerprints in the DB are produced by the worker's incremental
 * updateFingerprint (which chains fnv1aUpdate calls without per-step
 * finalization, starting from FNV_OFFSET for the '0' sentinel).
 * computeHistoryHash replicates this so that:
 *
 *   actor.historyFingerprint === computeHistoryHash([evt1, evt2, ...evtN])
 *
 * for an actor that processed exactly evt1…evtN in that order.
 */

import { getEngine } from './engine.js';
import {
  FNV_OFFSET,
  bigIntToHex64,
  computeHistoryFingerprint,
  updateFingerprint as updateFingerprintPure,
} from './fingerprintChain.js';

export { FNV_OFFSET };

// ── computeHash — generic one-shot hash ──────────────────────────────────────

/**
 * Compute a FNV-1a 64-bit hash over an array of string/Buffer items.
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
 * `eventTypes` in sequence, starting from the '0' initial sentinel
 * (i.e. from FNV_OFFSET).
 *
 * This mirrors actorWorker.js updateFingerprint exactly:
 *   - Starts from FNV_OFFSET (the '0' sentinel maps to this)
 *   - Chains fnv1aUpdate for each event type string
 *   - Does NOT call fnv1aFinal between steps
 *   - Does NOT call fnv1aFinal at the end (matches actorWorker chain exactly)
 *
 * Returns a 16-char lowercase hex string suitable for direct comparison
 * with actor.historyFingerprint.
 */
export function computeHistoryHash(eventTypes) {
  return computeHistoryFingerprint(eventTypes);
}

// ── updateFingerprint — incremental, for non-worker callers ──────────────────

/**
 * Update an existing fingerprint (hex string or '0' sentinel) with one
 * new event type.  Mirrors the worker's chain exactly.
 * Returns the new fingerprint as a 16-char hex string.
 */
// Only event.type contributes to the fingerprint, not payload.
// The fingerprint identifies which transitions an actor took, not what data it carried.
// Including payload would make historyPath declarations impossible to write.
export function updateFingerprint(currentHex, eventType) {
  return updateFingerprintPure(currentHex, eventType);
}

// ── Conversion helpers ────────────────────────────────────────────────────────

export function bigIntToHex(bi) {
  return bigIntToHex64(bi);
}

/**
 * Convert a stored fingerprint hex string to BigInt for engine calls.
 * The '0' sentinel means "no events processed" and maps to FNV_OFFSET
 * when used as a starting point for hashing — but as a BigInt value
 * passed to the engine it is kept as-is (0n = wildcard in some contexts).
 *
 * Callers that need the wildcard (0n) for apv_register_changepoint when
 * no historyPath is provided should use 0n directly, not hexToBigInt('0').
 *
 * Callers that need the actor's fingerprint for apv_compute_accessible
 * or apv_actor_started should use fingerprintToBigInt(actor.historyFingerprint),
 * which also maps '0' to 0n — acceptable because a just-spawned actor with
 * no events has not yet diverged from any prefix.
 */
export function hexToBigInt(hex) {
  if (!hex || hex === '0') return 0n;
  return BigInt(`0x${hex.padStart(16, '0')}`);
}

/** Convert hex fingerprint to BigInt for passing to the engine. */
export function fingerprintToBigInt(hex) {
  return hexToBigInt(hex);
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
  if (!hex || hex === '0') return bigIntToHex(FNV_OFFSET);
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
