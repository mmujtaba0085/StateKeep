/**
 * src/ffi/hashUtils.js
 *
 * FNV-1a hash helpers that wrap the engine's apv_fnv1a_* functions
 * (or the JS fallback equivalents).
 *
 * Two hashing surfaces exist here and must NOT be confused:
 *
 *   computeHash(items)
 *     Generic multi-item hash (calls fnv1aFinal once at the end).
 *     Used for computing prefix_hash when historyPath is absent
 *     and for other one-shot hash needs (region fingerprints).
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
 * finalization, starting from FNV32_OFFSET for the '0' sentinel).
 * computeHistoryHash replicates this so that:
 *
 *   actor.historyFingerprint === computeHistoryHash([evt1, evt2, ...evtN])
 *
 * for an actor that processed exactly evt1…evtN in that order.
 *
 * Type note: when the real C engine is loaded, fnv1aUpdate/fnv1aFinal return
 * BigInt (64-bit). In fallback mode they return plain numbers (32-bit).
 * bigIntToHex() handles both paths so callers are type-agnostic.
 */

import { getEngine } from './engine.js';
import {
  FNV32_OFFSET,
  bigIntToHex64,
  computeHistoryFingerprint,
  updateFingerprint as updateFingerprintPure,
} from './fingerprintChain.js';

// Re-export as FNV_OFFSET for callers that import the old name
export { FNV32_OFFSET as FNV_OFFSET };
export { FNV32_OFFSET };

// ── computeHash — generic one-shot hash ──────────────────────────────────────

/**
 * Compute a FNV-1a hash over an array of string/Buffer items.
 * Calls fnv1aFinal once at the end.
 * Returns a lowercase hex string (16 chars when C engine; 8 chars in fallback).
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
 * Returns an 8-char lowercase hex string (FNV-1a 32-bit).
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
 * Convert a hash value (BigInt from C engine, or number from fallback) to hex.
 * C engine → 16-char hex; fallback → 16-char hex (zero-padded).
 * Always returns 16 chars so region fingerprint consumers get a consistent width.
 */
export function bigIntToHex(bi) {
  if (typeof bi === 'bigint') {
    return (bi & 0xFFFFFFFFFFFFFFFFn).toString(16).padStart(16, '0');
  }
  return (bi >>> 0).toString(16).padStart(16, '0');
}

/**
 * Convert a stored fingerprint hex string to BigInt for engine calls.
 * The '0' sentinel means "no events processed" and maps to FNV32_OFFSET.
 *
 * Use hexToBigInt when you want 0n as an explicit wildcard (e.g. for
 * apv_register_changepoint when no historyPath is provided).
 *
 * Use fingerprintToBigInt when passing an actor's historyFingerprint
 * to apv_compute_accessible or apv_actor_started — '0' must map to
 * FNV32_OFFSET because 0n == APV_PREFIX_WILDCARD.
 */
export function hexToBigInt(hex) {
  if (!hex || hex === '0') return 0n;
  return BigInt(`0x${hex.padStart(16, '0')}`);
}

/** Convert actor historyFingerprint hex to BigInt for engine calls. */
export function fingerprintToBigInt(hex) {
  if (!hex || hex === '0') return BigInt(FNV32_OFFSET);
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
  if (!hex || hex === '0') return bigIntToHex(BigInt(FNV32_OFFSET));
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
