/**
 * @statekeep/xstate-apv — history-based version routing for XState v5 actors,
 * as a library (no StateKeep server).
 *
 * XState persists and restores actors, but moving a long-running actor to a new
 * machine version is left to you. This routes each actor by the path it took:
 *
 *   const router = createVersionRouter({
 *     versions: { 'loan-v1': loanV1, 'loan-v2': loanV2, 'loan-v3': loanV3 },
 *     releases: [
 *       { from: 'loan-v1', to: 'loan-v2', stateMapping: { info_needed: 'awaiting_documents' } },
 *       { from: 'loan-v2', to: 'loan-v3', historyPath: ['SUBMIT', 'REQUEST_INFO', 'RESUBMIT'] },
 *     ],
 *   });
 *   let rec = router.start('loan-v1', { amount: 5 });   // → { version, actor, history }
 *   rec = router.send(rec, { type: 'SUBMIT' });         // routes (may migrate), then sends
 *   const saved = router.persist(rec);                  // JSON: { version, snapshot, history }
 *   rec = router.restore(saved);                        // upgrades on restore when a release applies
 *   router.plan(savedRecords, 'loan-v3');               // who would move / be stranded — nothing changes
 *
 * Rules (same as the StateKeep server):
 *   - A release without `historyPath` moves every actor on `from`.
 *   - With `historyPath`, an actor moves when its history (event types since start)
 *     is exactly that path — at restore time, or later, just before its next event.
 *     Actors already past that point are not moved retroactively.
 *   - An actor whose current state does not exist in the target (and has no
 *     `stateMapping`) is never moved: it stays on its version and is reported stranded.
 *   - `contextTransform: { 'new.path': 'old.path' }` copies context fields on migration.
 *   - Releases chain (v1 → v2 → v3) and never go backwards.
 */
import { createActor } from 'xstate';

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const safePath = (p) => typeof p === 'string' && p.split('.').every((k) => k && !FORBIDDEN.has(k));
const getPath = (o, p) => p.split('.').reduce((c, k) => (c != null && Object.prototype.hasOwnProperty.call(c, k) ? c[k] : undefined), o);
function setPath(o, p, v) {
  const ks = p.split('.'); const last = ks.pop(); let c = o;
  for (const k of ks) { if (!Object.prototype.hasOwnProperty.call(c, k) || typeof c[k] !== 'object' || c[k] === null) c[k] = {}; c = c[k]; }
  c[last] = v;
}

const topState = (value) => (typeof value === 'string' ? value : Object.keys(value ?? {})[0]);
const stateExists = (machine, key) => !!machine.root.states?.[key];

export function createVersionRouter({ versions, releases = [] }) {
  if (!versions || typeof versions !== 'object') throw new Error('versions: { id: machine } is required');
  for (const r of releases) {
    if (!versions[r.from] || !versions[r.to]) throw new Error(`release ${r.from} → ${r.to}: unknown version`);
    for (const [to, from] of Object.entries(r.contextTransform ?? {})) {
      if (!safePath(to) || !safePath(from)) throw new Error(`release ${r.from} → ${r.to}: unsafe contextTransform path`);
    }
  }
  const order = new Map(releases.map((r, i) => [r, i]));   // releases apply in declaration order

  /** The next release that applies to (version, history), or null. */
  function nextRelease(version, history) {
    for (const r of releases) {
      if (r.from !== version) continue;
      if (!r.historyPath || r.historyPath.length === 0) return r;
      if (history.length === r.historyPath.length && r.historyPath.every((e, i) => e === history[i])) return r;
    }
    return null;
  }

  /** Can `snapshot` move to r.to? Returns { ok, value, reason }. */
  function checkMove(snapshot, r) {
    const target = versions[r.to];
    const from = topState(snapshot.value);
    const mapped = r.stateMapping?.[from];
    const to = mapped ?? from;
    if (!stateExists(target, to)) return { ok: false, reason: `state "${from}" does not exist in ${r.to}${mapped ? ` (mapped to "${mapped}")` : ''}` };
    let value = snapshot.value;
    if (mapped) value = typeof value === 'string' ? mapped : { [mapped]: value[from] };
    // a nested child state that no longer exists → enter the target state's initial child
    if (typeof value === 'object' && !target.root.states[to].states?.[Object.values(value)[0]]) value = to;
    return { ok: true, value };
  }

  function migrate(rec, r) {
    const check = checkMove(rec.actor.getSnapshot(), r);
    if (!check.ok) return { ...rec, stranded: { release: `${r.from}→${r.to}`, reason: check.reason } };
    const old = rec.actor.getSnapshot();
    let context = JSON.parse(JSON.stringify(old.context ?? {}));
    for (const [to, from] of Object.entries(r.contextTransform ?? {})) {
      const v = getPath(old.context ?? {}, from);
      if (v !== undefined) setPath(context, to, v);
    }
    const target = versions[r.to];
    const snapshot = target.resolveState({ value: check.value, context });
    rec.actor.stop();
    const actor = createActor(target, { snapshot }).start();
    return { version: r.to, actor, history: rec.history, migrations: [...(rec.migrations ?? []), `${r.from}→${r.to}`] };
  }

  /** Apply every release that currently applies (chains v1→v2→v3), stopping at a strand. */
  function route(rec) {
    let cur = rec;
    for (let guard = 0; guard < releases.length + 1; guard++) {
      const r = nextRelease(cur.version, cur.history);
      if (!r) return cur;
      const moved = migrate(cur, r);
      if (moved.stranded) return moved;
      cur = moved;
    }
    return cur;
  }

  return {
    /** Start a new actor on `version` (normally the newest). */
    start(version, input) {
      if (!versions[version]) throw new Error(`unknown version ${version}`);
      const actor = createActor(versions[version], { input }).start();
      return { version, actor, history: [], migrations: [] };
    },

    /** Route (maybe migrate) and deliver an event. Returns the updated record. */
    send(rec, event) {
      const routed = rec.stranded ? rec : route(rec);
      routed.actor.send(event);
      return { ...routed, history: [...routed.history, event.type] };
    },

    /** JSON-safe record for your database. */
    persist(rec) {
      return { version: rec.version, snapshot: rec.actor.getPersistedSnapshot(), history: rec.history, migrations: rec.migrations ?? [] };
    },

    /** Recreate from persist(); applies any release that is now due. */
    restore(saved) {
      if (!versions[saved.version]) throw new Error(`unknown version ${saved.version}`);
      const actor = createActor(versions[saved.version], { snapshot: saved.snapshot }).start();
      return route({ version: saved.version, actor, history: saved.history ?? [], migrations: saved.migrations ?? [] });
    },

    /** Dry run: what would restoring these saved actors do? Nothing is changed. */
    plan(savedList) {
      const out = { moves: [], stays: [], stranded: [] };
      savedList.forEach((saved, index) => {
        let version = saved.version;
        let value = saved.snapshot.value;
        const path = [];
        for (let i = 0; i < releases.length + 1; i++) {
          const r = nextRelease(version, saved.history ?? []);
          if (!r) break;
          const check = checkMove({ value }, r);
          if (!check.ok) { out.stranded.push({ index, version, state: topState(value), reason: check.reason }); return; }
          path.push(`${r.from}→${r.to}`); version = r.to; value = check.value;
        }
        (path.length ? out.moves : out.stays).push({ index, from: saved.version, to: version, via: path, state: topState(saved.snapshot.value) });
      });
      return out;
    },

    releases: releases.slice().sort((a, b) => order.get(a) - order.get(b)),
  };
}
