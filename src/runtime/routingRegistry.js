/**
 * src/runtime/routingRegistry.js
 *
 * The one place where change-points enter the engine and where routing questions are
 * answered (the rule Acc⁺ of the paper):
 *
 *  - Registration. A history-targeted change-point is registered under the actor
 *    fingerprint schemes in use: v2 (injective, SHA-256) and v1 (legacy FNV-1a, for
 *    actors that took transitions before the upgrade). Its pattern is kept in a JS-side
 *    table (`meta`) so an engine hit can be confirmed against the full digest.
 *  - Lookup. Scalar and parallel registries are both asked and the EARLIER hit wins
 *    (at equal times the scalar one). Earlier builds asked the parallel registry only
 *    when the scalar one had no answer, so a later scalar change-point could shadow an
 *    earlier parallel one.
 *  - Verification. The engine is keyed on 64 bits. A v2 hit whose full digest differs
 *    from the actor's is a key collision; the answer is then recomputed exactly from
 *    `meta`.
 *  - Collection. collect(machineId, frontier) removes every change-point below the
 *    family's collection frontier from the engine and from `meta`.
 */

import { getEngine, scopeOf } from '../ffi/engine.js';
import {
  computeHistoryFingerprint, engineKey, schemeOf, sameFingerprint, isEmpty,
} from '../ffi/fingerprintChain.js';
import { computeRegionHashes, regionFingerprintsToArray, hexToBigInt } from '../ffi/hashUtils.js';

/** scope (string) → Map<`${kind}:${t}`, entry> */
const meta = new Map();

function scopeKey(scope) { return String(scope); }
function metaFor(scope) {
  const k = scopeKey(scope);
  let m = meta.get(k);
  if (!m) { m = new Map(); meta.set(k, m); }
  return m;
}

/** Normalise a historyPath element: {after:'a.b', ms:5000} → the timer's event type. */
export function historyToken(e) {
  if (e && typeof e === 'object' && typeof e.after === 'string') {
    const ms = Number(e.ms ?? e.delay);
    return `__SK_TIMEOUT_${e.after.replace(/\./g, '_')}_${ms}`;
  }
  return String(e);
}
export function normalizeHistoryPath(path) {
  return Array.isArray(path) ? path.map(historyToken) : path;
}

/**
 * Register a scalar change-point. `storedPrefix` is the key persisted in the database
 * ('0' = wildcard, otherwise the legacy v1 key as a decimal string); `historyPath` the
 * pattern (from the child definition), needed for the v2 key.
 */
export function registerScalar({ tStar, storedPrefix, refinement = 1, childDefId, machineId, historyPath = null }) {
  const eng = getEngine();
  const scope = scopeOf(machineId);
  const t = BigInt(tStar), r = BigInt(refinement || 1);
  const wildcard = String(storedPrefix) === '0';
  const pattern = wildcard ? null : normalizeHistoryPath(historyPath);
  let rc = eng.registerChangepoint(t, BigInt(storedPrefix), r, childDefId, scope);
  let v2 = null;
  if (pattern && pattern.length > 0) {
    v2 = computeHistoryFingerprint(pattern, 2);
    const k1 = engineKey(computeHistoryFingerprint(pattern, 1));
    if (k1 !== BigInt(storedPrefix)) eng.registerChangepoint(t, k1, r, childDefId, scope);
    rc = eng.registerChangepoint(t, engineKey(v2), r, childDefId, scope);
  }
  const v1 = pattern && pattern.length > 0 ? computeHistoryFingerprint(pattern, 1) : null;
  // An exact change-point whose pattern is unknown (no historyPath stored) matches only
  // legacy fingerprints with its stored key; it is never treated as a wildcard.
  metaFor(scope).set(`s:${t}`, { kind: 's', t, target: childDefId, pattern, v2, v1, wild: wildcard,
    v1key: wildcard ? 0n : BigInt(storedPrefix) });
  return rc;
}

/**
 * Register a parallel change-point. `historyRegions` is the normalised
 * { regionPath: [events] } selector; `storedRegions` the legacy persisted form
 * ({ regionPath: v1 fingerprint } or an array of v1 keys), used when no selector is known.
 * Returns the engine's return code for the v2 selector (-2 = ambiguous).
 */
export function registerParallel({ tStar, storedRegions = null, refinement = 1, childDefId, machineId, historyRegions = null }) {
  const eng = getEngine();
  const scope = scopeOf(machineId);
  const t = BigInt(tStar), r = BigInt(refinement || 1);
  let rc = 0;
  let regionsV2 = null, regionsV1 = null;
  if (historyRegions && Object.keys(historyRegions).length > 0) {
    const hr = Object.fromEntries(Object.entries(historyRegions).map(([k, v]) => [k, normalizeHistoryPath(v)]));
    regionsV2 = computeRegionHashes(hr, 2);
    const arr2 = regionFingerprintsToArray(regionsV2, 2);
    if (arr2?.length) rc = eng.registerChangepointParallel(t, arr2, r, childDefId, scope);
    if (rc === -2) return rc;                       // ambiguous: register nothing
    const v1map = computeRegionHashes(hr, 1);
    regionsV1 = v1map;
    const arr1 = regionFingerprintsToArray(v1map, 1);
    if (arr1?.length) eng.registerChangepointParallel(t, arr1, r, childDefId, scope);
  } else if (storedRegions) {
    const arr = Array.isArray(storedRegions)
      ? storedRegions.map((h) => hexToBigInt(String(h).padStart(16, '0')))
      : regionFingerprintsToArray(storedRegions, 1);
    if (arr?.length) rc = eng.registerChangepointParallel(t, arr, r, childDefId, scope);
  }
  const regionPatterns = historyRegions
    ? Object.fromEntries(Object.entries(historyRegions).map(([k, v]) => [k, normalizeHistoryPath(v)])) : null;
  metaFor(scope).set(`p:${t}`, { kind: 'p', t, target: childDefId, regionsV2, regionsV1, regionPatterns });
  return rc;
}

// ── lookup ───────────────────────────────────────────────────────────────────

function scalarMatches(m, fp) {
  if (m.wild) return true;
  if (schemeOf(fp) === 1 && m.legacyAmbiguous) return false;     // legacyFingerprints.js
  if (m.pattern && m.pattern.length > 0) return sameFingerprint(schemeOf(fp) === 1 ? m.v1 : m.v2, fp);
  return schemeOf(fp) === 1 && engineKey(fp) === m.v1key;       // pattern unknown: legacy key only
}

function verifyScalar(scope, hit, fp) {
  if (hit.key === 0n || hit.tStar == null) return true;
  const m = meta.get(scopeKey(scope))?.get(`s:${hit.tStar}`);
  if (schemeOf(fp) === 1) return !m?.legacyAmbiguous;   // a legacy match is exact only if unambiguous
  if (!m || !m.v2) return true;                 // registered elsewhere: nothing to check
  return sameFingerprint(m.v2, fp);
}

function scalarByScan(scope, T, fp) {
  let best = null;
  for (const m of meta.get(scopeKey(scope))?.values() ?? []) {
    if (m.kind !== 's' || m.t < T) continue;
    const exact = m.wild ? false : scalarMatches(m, fp);
    if (!m.wild && !exact) continue;
    const cand = { target: m.target, tStar: m.t, key: exact ? engineKey(fp) : 0n };
    if (!best || cand.tStar < best.tStar || (cand.tStar === best.tStar && best.key === 0n && cand.key !== 0n)) best = cand;
  }
  return best;
}

function regionsMatch(selectorV2, actorRegions) {
  for (const [path, fp] of Object.entries(selectorV2)) {
    const own = actorRegions?.[path];
    if (own === undefined || !sameFingerprint(own, fp)) return false;
  }
  return true;
}

function verifyParallel(scope, hit, regionFps) {
  if (hit.tStar == null) return true;
  const m = meta.get(scopeKey(scope))?.get(`p:${hit.tStar}`);
  if (Object.values(regionFps).some((v) => !isEmpty(v) && schemeOf(v) === 1)) return !m?.legacyAmbiguous;   // legacy
  if (!m || !m.regionsV2) return true;
  return regionsMatch(m.regionsV2, regionFps);
}

function parallelByScan(scope, T, regionFps) {
  let best = null;
  for (const m of meta.get(scopeKey(scope))?.values() ?? []) {
    if (m.kind !== 'p' || m.t < T || !m.regionsV2 || !regionsMatch(m.regionsV2, regionFps)) continue;
    const n = Object.keys(m.regionsV2).length;
    if (!best || m.t < best.tStar || (m.t === best.tStar && n > best.n)) best = { target: m.target, tStar: m.t, n };
  }
  return best ? { target: best.target, tStar: best.tStar } : null;
}

/**
 * Acc⁺ for an actor: { target, tStar, kind } or null.
 *   fp          — the actor's history fingerprint
 *   regionFps   — its regional fingerprints (or null)
 *   T           — its logical time; tick — the current clock (unused by the rule)
 */
export function lookup({ machineId, fp, regionFps, T, tick = 0n }) {
  const eng = getEngine();
  const scope = scopeOf(machineId);
  const logT = BigInt(T), cur = BigInt(tick);
  let s = eng.computeAccessibleEx(engineKey(fp), logT, cur, scope);
  if (s && !verifyScalar(scope, s, fp)) s = scalarByScan(scope, logT, fp);
  let p = null;
  if (regionFps && Object.keys(regionFps).length > 0) {
    const arr = regionFingerprintsToArray(regionFps);
    if (arr?.length) {
      p = eng.computeAccessibleParallelEx(arr, logT, cur, scope);
      if (p && !verifyParallel(scope, p, regionFps)) p = parallelByScan(scope, logT, regionFps);
    }
  }
  if (!s && !p) return null;
  if (!p) return { ...s, kind: 'scalar' };
  if (!s) return { ...p, kind: 'parallel' };
  if (s.tStar == null || p.tStar == null) return { ...s, kind: 'scalar' };   // engine build without _ex
  return p.tStar < s.tStar ? { ...p, kind: 'parallel' } : { ...s, kind: 'scalar' };
}

// ── collection ───────────────────────────────────────────────────────────────

/** Remove every change-point of the family with t* < frontier. Returns the count. */
export function collect(machineId, frontier) {
  const eng = getEngine();
  const scope = scopeOf(machineId);
  const f = BigInt(frontier);
  const n = eng.collectBefore(scope, f);
  const m = meta.get(scopeKey(scope));
  if (m) for (const [k, e] of m) if (e.t < f) m.delete(k);
  return n;
}

/** Number of change-points known for a family (for tests and metrics). */
export function metaCount(machineId) {
  return meta.get(scopeKey(scopeOf(machineId)))?.size ?? 0;
}

// ── exact rule over the JS-side table (deploy-time simulation) ──────────────

/**
 * Acc⁺ computed from `meta` alone, optionally with extra (not yet registered) entries
 * { kind: 's', t, target, pattern } / { kind: 'p', t, target, historyRegions }.
 * Exact for both fingerprint schemes; used to predict routing before a deployment
 * commits (the engine is not touched).
 */
export function simulateLookup({ machineId, fp, regionFps, T, extra = [] }) {
  const scope = scopeOf(machineId);
  const logT = BigInt(T);
  const legacy = schemeOf(fp) === 1;
  const regionLegacy = Object.values(regionFps ?? {}).some((v) => !isEmpty(v) && schemeOf(v) === 1);
  const entries = [...(meta.get(scopeKey(scope))?.values() ?? []), ...extra.map(prepareExtra)];
  let s = null, p = null;
  for (const m of entries) {
    if (m.t < logT) continue;
    if (m.kind === 's') {
      const exact = m.wild ? false : scalarMatches(m, fp);
      if (!m.wild && !exact) continue;
      if (!s || m.t < s.tStar || (m.t === s.tStar && !s.exact && exact)) s = { target: m.target, tStar: m.t, exact };
    } else if (m.kind === 'p' && regionFps && (regionLegacy ? m.regionsV1 : m.regionsV2)) {
      const sel = regionLegacy ? m.regionsV1 : m.regionsV2;
      if (regionLegacy && m.legacyAmbiguous) continue;
      if (!regionsMatch(sel, regionFps)) continue;
      const n = Object.keys(sel).length;
      if (!p || m.t < p.tStar || (m.t === p.tStar && n > p.n)) p = { target: m.target, tStar: m.t, n };
    }
  }
  if (!s && !p) return null;
  if (!p) return { target: s.target, tStar: s.tStar, kind: 'scalar' };
  if (!s) return { target: p.target, tStar: p.tStar, kind: 'parallel' };
  return p.tStar < s.tStar ? { target: p.target, tStar: p.tStar, kind: 'parallel' }
                           : { target: s.target, tStar: s.tStar, kind: 'scalar' };
}

function prepareExtra(e) {
  const t = BigInt(e.t);
  if (e.kind === 's') {
    const pattern = e.pattern && e.pattern.length ? normalizeHistoryPath(e.pattern) : null;
    return { kind: 's', t, target: e.target, pattern, wild: !pattern,
      v2: pattern ? computeHistoryFingerprint(pattern, 2) : null,
      v1: pattern ? computeHistoryFingerprint(pattern, 1) : null,
      v1key: pattern ? engineKey(computeHistoryFingerprint(pattern, 1)) : 0n };
  }
  const hr = Object.fromEntries(Object.entries(e.historyRegions ?? {}).map(([k, v]) => [k, normalizeHistoryPath(v)]));
  return { kind: 'p', t, target: e.target, regionsV2: computeRegionHashes(hr, 2), regionsV1: computeRegionHashes(hr, 1) };
}

/** Change-point entries of a family with t* >= from (for the late-matcher check). */
export function familyEntries(machineId) {
  return [...(meta.get(scopeKey(scopeOf(machineId)))?.values() ?? [])];
}

/**
 * Mark every change-point of a family whose legacy (v1) match would be ambiguous over
 * the family's event types (see legacyFingerprints.js). `isAmbiguous(pattern)` decides.
 */
export function markLegacyAmbiguity(machineId, isAmbiguous) {
  for (const m of familyEntries(machineId)) {
    if (m.kind === 's') m.legacyAmbiguous = !!(m.pattern && isAmbiguous(m.pattern));
    else m.legacyAmbiguous = Object.values(m.regionPatterns ?? {}).some((p) => isAmbiguous(p));
  }
}
