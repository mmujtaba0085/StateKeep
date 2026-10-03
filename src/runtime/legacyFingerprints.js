/**
 * src/runtime/legacyFingerprints.js — making legacy (v1, FNV-1a over the plain
 * concatenation of event types) fingerprints exact.
 *
 * A v1 fingerprint identifies the CONCATENATION of an actor's transition events, not the
 * sequence: [PAY, MENT_OK] and [PAYMENT_OK] collide. Two tools close the gap:
 *
 *  1. Unique factorization. If the concatenation of a pattern π can be split into a
 *     sequence of the family's event types in exactly one way, then a legacy actor whose
 *     v1 fingerprint equals v1(π) has history exactly π (barring a 64-bit hash collision):
 *     every event it took is one of those event types. Legacy matches against patterns
 *     whose concatenation is ambiguous are refused (never guessed), and such actors are
 *     upgraded first.
 *
 *  2. Verified upgrade. An actor's transition history is reconstructed by replaying its
 *     event log through the definitions it occupied (MIGRATED records give each switch and
 *     landing state). The reconstruction is accepted only if it ends in the actor's stored
 *     configuration, reproduces its stored v1 fingerprint (main and regional), and no OTHER
 *     subsequence of the logged events has the same concatenation (every transition the
 *     actor took is in its log) — then it IS the actor's history, and its v2 fingerprint
 *     replaces the legacy one. Anything else
 *     (unknown initial context changing a guard, remote guards, missing log rows) leaves
 *     the actor legacy, and it is reported.
 */

import { computeHistoryFingerprint, isLegacy, isEmpty, sameFingerprint } from '../ffi/fingerprintChain.js';
import { compileMachine } from './definitionCompiler.js';
import { processEvent, computeInitialSnapshot } from './interpreter.js';
import { initializeRegionFingerprints } from './statePaths.js';
import { applyContextTransform } from './actorWorker.js';
import { getGlobalRegistry } from './implementationRegistry.js';
import { withConditions } from './conditionGuards.js';

// ── alphabet and factorization ───────────────────────────────────────────────

/** Event types that can cause a transition in any of the given definitions; null = any
 *  string (a definition has a wildcard transition). */
export function familyAlphabet(definitions) {
  const out = new Set();
  for (const def of definitions) {
    let compiled = def.compiledJson;
    if (!compiled) { try { compiled = compileMachine(def.definitionJson); } catch { continue; } }
    for (const key of Object.keys(compiled.transitions ?? {})) {
      const i = key.indexOf(':');
      const ev = i >= 0 ? key.slice(i + 1) : key;
      if (ev === '*' || ev === '') return null;
      out.add(ev);
    }
    for (const list of Object.values(compiled.afterTransitions ?? {})) {
      for (const e of list ?? []) if (e?.eventType) out.add(e.eventType);
    }
  }
  return out;
}

/** Number of ways (capped at 2) to split `word` into a sequence of alphabet words. */
export function factorizations(word, alphabet) {
  if (alphabet === null) return word.length <= 1 ? 1 : 2;
  const n = word.length;
  const ways = new Array(n + 1).fill(0);
  ways[0] = 1;
  const lens = [...new Set([...alphabet].map((w) => w.length))].filter((l) => l > 0);
  for (let i = 1; i <= n; i++) {
    let w = 0;
    for (const l of lens) {
      if (l <= i && ways[i - l] > 0 && alphabet.has(word.slice(i - l, i))) w += ways[i - l];
      if (w >= 2) break;
    }
    ways[i] = Math.min(w, 2);
  }
  return ways[n];
}

/** Is a legacy match against `pattern` ambiguous over `alphabet`? */
export function legacyPatternAmbiguous(pattern, alphabet) {
  if (!pattern || pattern.length === 0) return false;
  const a = alphabet === null ? null : new Set([...alphabet, ...pattern]);
  return factorizations(pattern.join(''), a) !== 1;
}

/**
 * Number of ways (capped at 2) to pick a subsequence of the logged events whose
 * concatenation is `word`. Every transition an actor took is in its log, so if this is 1,
 * the log and the v1 fingerprint alone determine the transition history.
 * Returns null when the problem is too large to decide here.
 */
export function logSubsequences(word, logTypes, maxCells = 5_000_000) {
  const n = logTypes.length, m = word.length;
  if ((n + 1) * (m + 1) > maxCells) return null;
  let next = new Array(m + 1).fill(0);
  next[m] = 1;                                   // i = n: only the empty suffix of word
  for (let i = n - 1; i >= 0; i--) {
    const e = logTypes[i];
    const cur = next.slice();                    // skip event i
    if (e.length > 0) {
      for (let p = 0; p + e.length <= m; p++) {
        if (next[p + e.length] > 0 && word.startsWith(e, p)) cur[p] = Math.min(2, cur[p] + next[p + e.length]);
      }
    }
    next = cur;
  }
  return next[0];
}

function uniquelyDetermined(seq, logTypes, alphabet) {
  if (seq.length === 0) return true;
  const w = seq.join('');
  const viaLog = logSubsequences(w, logTypes);
  if (viaLog !== null) return viaLog === 1;
  const a = alphabet === null ? null : new Set([...alphabet, ...seq]);
  return factorizations(w, a) === 1;
}

// ── replay ───────────────────────────────────────────────────────────────────

function sameState(a, b) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }

/**
 * Reconstruct an actor's transition history from its event log.
 * @param actor     { definitionId, stateValue, historyFingerprint, regionFingerprints }
 * @param events    [{ type, payload }] in log order
 * @param getDef    async id → definition record
 * @param alphabet  family alphabet (familyAlphabet)
 * @returns { ok: true, fp, regionFps } or { ok: false, reason }
 */
export async function reconstructHistory(actor, events, getDef, alphabet) {
  const registry = withConditions(getGlobalRegistry() ?? { guards: {}, actions: {}, services: {} });
  const firstSwitch = events.find((e) => e.type === 'MIGRATED' || e.type === 'MIGRATION_FAILED');
  let defId = firstSwitch?.payload?.fromDefinitionId ?? actor.definitionId;
  let def = await getDef(defId);
  if (!def) return { ok: false, reason: 'definition_missing' };
  const compiledOf = (d) => d.compiledJson ?? compileMachine(d.definitionJson);
  let compiled = compiledOf(def);
  const snap = computeInitialSnapshot(compiled, def.definitionJson, {}, registry);
  if (snap.error) return { ok: false, reason: 'initial_state' };
  let entry = {
    stateValue: snap.stateValue, context: snap.context ?? {}, historyFingerprint: '0',
    stateEntryId: snap.stateEntryId ?? 0,
    regionFingerprints: initializeRegionFingerprints(def.definitionJson, snap.stateValue, null),
  };
  const seq = [];
  const regionSeq = {};
  for (const ev of events) {
    if (ev.type === 'SPAWN') continue;
    if (ev.type === 'MIGRATED' || ev.type === 'MIGRATION_FAILED') {
      const to = ev.payload?.toDefinitionId;
      const next = to ? await getDef(to) : null;
      if (!next) return { ok: false, reason: 'migration_record' };
      def = next; defId = to; compiled = compiledOf(def);
      if (ev.type === 'MIGRATED') {
        entry.stateValue = ev.payload.toState ?? entry.stateValue;
        try { entry.context = applyContextTransform(entry.context ?? {}, def.definitionJson._contextTransform ?? null); } catch {}
      }
      entry.regionFingerprints = initializeRegionFingerprints(def.definitionJson, entry.stateValue, entry.regionFingerprints);
      continue;
    }
    const payload = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    const event = { ...payload, type: ev.type };
    let proc = entry;
    if (!ev.type.startsWith('__SK_')) {
      const { type: _t, ...fields } = payload;
      if (Object.keys(fields).length) proc = { ...entry, context: { ...entry.context, ...fields } };
    }
    let r;
    try { r = processEvent({ ...proc }, compiled, event, registry, []); }
    catch { return { ok: false, reason: 'replay_error' }; }
    if (r.error) return { ok: false, reason: r.error };
    if (r.historyFingerprint !== proc.historyFingerprint) seq.push(ev.type);
    for (const [path, fp] of Object.entries(r.regionFingerprints ?? {})) {
      if (fp !== (proc.regionFingerprints ?? {})[path]) (regionSeq[path] ??= []).push(ev.type);
    }
    entry = { ...proc, ...r };
  }

  // verification
  if (!sameState(entry.stateValue, actor.stateValue)) return { ok: false, reason: 'state_mismatch' };
  if (isLegacy(actor.historyFingerprint) &&
      !sameFingerprint(computeHistoryFingerprint(seq, 1), actor.historyFingerprint)) {
    return { ok: false, reason: 'fingerprint_mismatch' };
  }
  if (isEmpty(actor.historyFingerprint) !== (seq.length === 0)) return { ok: false, reason: 'fingerprint_mismatch' };
  const logTypes = events.map((e) => e.type)
    .filter((t) => t !== 'SPAWN' && t !== 'MIGRATED' && t !== 'MIGRATION_FAILED');
  if (!uniquelyDetermined(seq, logTypes, alphabet)) return { ok: false, reason: 'ambiguous' };
  const regionFps = {};
  for (const [path, stored] of Object.entries(actor.regionFingerprints ?? {})) {
    const rs = regionSeq[path] ?? [];
    if (isLegacy(stored) && !sameFingerprint(computeHistoryFingerprint(rs, 1), stored)) {
      return { ok: false, reason: 'region_fingerprint_mismatch' };
    }
    if (!uniquelyDetermined(rs, logTypes, alphabet)) return { ok: false, reason: 'ambiguous' };
    regionFps[path] = computeHistoryFingerprint(rs, 2);
  }
  return { ok: true, fp: computeHistoryFingerprint(seq, 2), regionFps, transitions: seq.length };
}
