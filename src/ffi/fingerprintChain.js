// History fingerprints.
//
// An actor's history fingerprint identifies the sequence of event types whose
// transitions it has taken (event *types*, never payloads, so historyPath declarations
// stay writable). Two schemes exist:
//
//   v2 (current)  "2:<64 hex>" — SHA-256 chain over a length-prefixed encoding:
//                   h0     = SHA-256("statekeep.fp.v2|empty")
//                   h(n+1) = SHA-256(h(n) ‖ u32be(len(e)) ‖ utf8(e))
//                 Injective (the length prefix separates events: PAY,MENT_OK differs
//                 from PAYMENT_OK) and collision-resistant. The engine is keyed on the
//                 first 64 bits; a hit is confirmed against the full digest.
//
//   v1 (legacy)   16 hex chars — 64-bit FNV-1a over the plain concatenation of event
//                 types. NOT injective. Only actors that took a transition before the
//                 upgrade still carry it; they keep extending it (their earlier events
//                 cannot be re-encoded), and every history-targeted deployment is
//                 registered under both schemes so they are still routed.
//
// '0' is the empty history in both schemes. An actor at '0' extends in v2 (or in the
// scheme of the `hint`, used to keep an actor's regional fingerprints in the same scheme
// as its main fingerprint).

import { createHash } from 'node:crypto';

export const FNV64_PRIME  = 0x00000100000001b3n;
export const FNV64_OFFSET = 0xcbf29ce484222325n;
export const EMPTY = '0';
const V2 = '2:';

export function bigIntToHex64(value) {
  return (BigInt(value) & 0xFFFFFFFFFFFFFFFFn).toString(16).padStart(16, '0');
}

// ── scheme detection ─────────────────────────────────────────────────────────

export function isV2(fp) { return typeof fp === 'string' && fp.startsWith(V2); }
export function isLegacy(fp) { return typeof fp === 'string' && fp !== EMPTY && /^[0-9a-f]{1,16}$/i.test(fp); }
export function isEmpty(fp) { return fp == null || fp === EMPTY || fp === ''; }
/** 1 or 2. The empty history takes the hint's scheme (default v2). */
export function schemeOf(fp, hint = 2) { return isLegacy(fp) ? 1 : isV2(fp) ? 2 : hint; }

// ── v1 (legacy FNV-1a) ───────────────────────────────────────────────────────

function fnv1aUpdate(hash, value) {
  const buf = Buffer.from(String(value), 'utf8');
  let h = hash;
  for (const byte of buf) h = ((h ^ BigInt(byte)) * FNV64_PRIME) & 0xFFFFFFFFFFFFFFFFn;
  return h;
}

export function computeHistoryFingerprintV1(eventTypes) {
  let h = FNV64_OFFSET;
  for (const e of eventTypes ?? []) h = fnv1aUpdate(h, e);
  return bigIntToHex64(h);
}

function updateV1(currentHex, eventType) {
  const current = isEmpty(currentHex) ? FNV64_OFFSET : BigInt(`0x${currentHex.padStart(16, '0')}`);
  return bigIntToHex64(fnv1aUpdate(current, eventType));
}

// ── v2 (length-prefixed SHA-256 chain) ───────────────────────────────────────

const V2_EMPTY_DIGEST = createHash('sha256').update('statekeep.fp.v2|empty').digest();

function digestOf(fp) {
  if (isEmpty(fp)) return V2_EMPTY_DIGEST;
  return Buffer.from(fp.slice(V2.length), 'hex');
}

function stepV2(digest, eventType) {
  const e = Buffer.from(String(eventType), 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32BE(e.length, 0);
  return createHash('sha256').update(digest).update(len).update(e).digest();
}

export function computeHistoryFingerprintV2(eventTypes) {
  let d = V2_EMPTY_DIGEST;
  for (const e of eventTypes ?? []) d = stepV2(d, e);
  return (eventTypes?.length ?? 0) === 0 ? EMPTY : V2 + d.toString('hex');
}

// ── scheme-dispatching API ───────────────────────────────────────────────────

/** Fingerprint after taking `eventType` (in the fingerprint's own scheme). */
export function updateFingerprint(current, eventType, hint = 2) {
  return schemeOf(current, hint) === 1
    ? updateV1(current, eventType)
    : V2 + stepV2(digestOf(current), eventType).toString('hex');
}

/** Fingerprint of a path of event types, in the given scheme (default v2). */
export function computeHistoryFingerprint(eventTypes, scheme = 2) {
  if (!eventTypes || eventTypes.length === 0) return EMPTY;
  return scheme === 1 ? computeHistoryFingerprintV1(eventTypes) : computeHistoryFingerprintV2(eventTypes);
}

/** 64-bit engine key of a fingerprint: never 0 (0 is the wildcard). */
export function engineKey(fp) {
  if (isLegacy(fp)) return BigInt(`0x${fp.padStart(16, '0')}`) || 1n;
  const k = digestOf(fp).readBigUInt64BE(0);
  return k === 0n ? 1n : k;
}

/** Does an actor with fingerprint `fp` have exactly the history `eventTypes`? */
export function fingerprintMatchesPath(fp, eventTypes) {
  if (!eventTypes || eventTypes.length === 0) return isEmpty(fp);
  if (isEmpty(fp)) return false;
  return computeHistoryFingerprint(eventTypes, schemeOf(fp)) === normalize(fp);
}

function normalize(fp) { return isLegacy(fp) ? fp.toLowerCase().padStart(16, '0') : fp; }

/** Two fingerprints denote the same history (same scheme required). */
export function sameFingerprint(a, b) {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b);
  return normalize(a) === normalize(b);
}

/** Scheme hint for an actor's regional fingerprints: that of any non-empty one. */
export function regionSchemeHint(mainFp, regionFps) {
  if (!isEmpty(mainFp)) return schemeOf(mainFp);
  for (const v of Object.values(regionFps ?? {})) if (!isEmpty(v)) return schemeOf(v);
  return 2;
}

// ── region keys (v2; v1 keys are computed in hashUtils with the engine's FNV) ─

export function regionKeyV2(regionPath, fp) {
  const p = Buffer.from(String(regionPath), 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32BE(p.length, 0);
  const k = createHash('sha256').update('statekeep.region.v2|').update(len).update(p)
    .update(digestOf(isLegacy(fp) ? EMPTY : fp)).digest().readBigUInt64BE(0);
  return k === 0n ? 1n : k;
}
