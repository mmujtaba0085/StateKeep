/**
 * src/runtime/deployAnalysis.js — what a deployment will do, computed before it commits.
 *
 * 1. predictRouting: for every actor of the family that can still be routed (active or
 *    stranded), run the real routing rule (Acc⁺, routingRegistry.simulateLookup) with
 *    the new change-point added, and apply each hop's real state mapping and context
 *    transform, until a fixpoint — exactly what the actor's owner will do. The result
 *    says which actors move through the new version, and which would be stranded, at
 *    which version and in which state. (The earlier check compared top-level state
 *    names with the new definition only, ignoring chains of pending deployments and
 *    nested states.) It reads the state at the time of the check; actors that take
 *    events before the commit are routed by the same rule afterwards, so a prediction
 *    can be out of date but routing itself stays safe.
 *
 * 2. lateMatcherRisk: for a history-targeted deployment, actors that do not match now
 *    can match later (their history grows into the pattern). A sound check for the new
 *    version's own hop: every leaf state of every version such an actor can be on must
 *    be mappable. Those versions are the ones hosting routable actors now plus the
 *    targets of change-points not yet collected (an actor can still be moved there);
 *    versions below the collection frontier with no actors are excluded.
 */

import { simulateLookup, familyEntries } from './routingRegistry.js';
import { findVersionsHostingActors } from '../registry/actorRepo.js';
import { resolveLandingState, unplaceableConfigurations } from './stateMapping.js';
import { applyContextTransform } from './actorWorker.js';
import { initializeRegionFingerprints } from './statePaths.js';

function logicalTime(actor, def) {
  const dep = Number(def?.deployedAt ?? 0) + 1;
  const own = Number(actor.logicalStartTick ?? 0);
  return Math.max(dep, own);
}

/**
 * @param actors      routable actors of the family (DB records)
 * @param getDef      async id → definition record ({ id, deployedAt, definitionJson })
 * @param candidate   { id, kind: 's'|'p', pattern?, historyRegions?, definitionJson, t }
 * @returns { moves: [{actorId, hops}], stranded: [{actorId, atVersion, state, reason}], stays: [...] }
 */
export async function predictRouting({ machineId, actors, getDef, candidate }) {
  const extra = [{ kind: candidate.kind, t: candidate.t, target: candidate.id,
    pattern: candidate.pattern ?? null, historyRegions: candidate.historyRegions ?? null }];
  const defOf = async (id) => (id === candidate.id
    ? { id, deployedAt: candidate.t, definitionJson: candidate.definitionJson }
    : getDef(id));
  const moves = [], stranded = [], stays = [];
  for (const a of actors) {
    let defId = a.definitionId, sv = a.stateValue, ctx = a.context ?? {};
    let rf = a.regionFingerprints ?? null;
    let def = await defOf(defId);
    let T = logicalTime(a, def);
    const hops = [];
    let outcome = null;
    for (let i = 0; i < 10_000; i++) {
      const hit = simulateLookup({ machineId, fp: a.historyFingerprint, regionFps: rf, T, extra });
      if (!hit || hit.target === defId) break;
      const tdef = await defOf(hit.target);
      if (!tdef) break;
      const dj = tdef.definitionJson ?? {};
      const landing = resolveLandingState(sv, dj.states ?? {}, dj._stateMapping ?? {});
      if (!landing) { outcome = { atVersion: hit.target, state: sv, reason: 'STATE_NOT_MAPPABLE' }; break; }
      try { ctx = applyContextTransform(ctx ?? {}, dj._contextTransform ?? null); }
      catch { outcome = { atVersion: hit.target, state: sv, reason: 'CONTEXT_TRANSFORM_FAILED' }; break; }
      sv = landing;
      try { rf = initializeRegionFingerprints(dj, sv, rf); } catch {}
      hops.push(hit.target);
      defId = hit.target; def = tdef; T = Number(hit.tStar) + 1;
    }
    if (outcome) stranded.push({ actorId: a.id, ...outcome, hopsBefore: hops });
    else if (hops.includes(candidate.id)) moves.push({ actorId: a.id, hops });
    else stays.push({ actorId: a.id, hops });
  }
  return { moves, stranded, stays };
}

/**
 * Leaf states that an actor matching the pattern LATER could be in, and that the new
 * version's mapping cannot place. [{ version, states: [leafPath] }] — empty means no
 * late matcher can be stranded at the new version's own hop for lack of a state mapping.
 */
export async function lateMatcherRisk({ machineId, actors, getDef, candidate }) {
  if (candidate.kind === 's' && !(candidate.pattern?.length)) return [];   // wildcard: no late matchers
  const versions = new Set(actors.map((a) => a.definitionId));
  // archived actors can be restored and then match: their versions count too
  for (const v of await findVersionsHostingActors(machineId).catch(() => [])) versions.add(v);
  for (const e of familyEntries(machineId)) if (BigInt(e.t) < BigInt(candidate.t)) versions.add(e.target);
  const dj = candidate.definitionJson ?? {};
  const out = [];
  for (const v of versions) {
    const def = await getDef(v);
    if (!def) continue;
    const bad = unplaceableConfigurations(def.definitionJson?.states ?? {}, dj.states ?? {}, dj._stateMapping ?? {});
    if (bad.leaves.length || bad.pairs.length) {
      out.push({ version: v, states: bad.leaves, ...(bad.pairs.length ? { conflictingPairs: bad.pairs } : {}) });
    }
  }
  return out;
}
