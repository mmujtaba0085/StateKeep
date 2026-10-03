/**
 * src/runtime/stateMapping.js
 *
 * The state mapping μ of a migration: where an actor lands in the new definition.
 *
 * Every active leaf of the actor's configuration (one per active parallel region) is
 * mapped on its own:
 *   - by the longest prefix of its path that is a key of `stateMapping`
 *     (keys and values are dot paths: "shipping.packing": "shipping.fulfilment";
 *     a top-level key "checkout": "purchase" maps the whole subtree), landing on the
 *     mapped state (entering its initial descendants), or
 *   - to the same path, which must then exist in the new definition.
 * The mapped leaves are then assembled into a configuration of the new definition:
 * parallel regions nobody landed in start at their initial state, and a compound state
 * that two leaves would enter in different children is a conflict.
 *
 * If any leaf cannot be mapped, or the assembly fails, the result is null and the actor
 * is stranded — it is never placed in a state that does not exist. (Earlier builds only
 * checked the top-level state, so a removed nested state was carried over as-is.)
 */

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Active leaf paths of a state value, as arrays of segments. */
export function leafPaths(sv, prefix = []) {
  if (typeof sv === 'string') return [[...prefix, sv]];
  if (!isObj(sv)) return [];
  const keys = Object.keys(sv);
  if (keys.length === 0) return prefix.length ? [prefix] : [];
  return keys.flatMap((k) => {
    const v = sv[k];
    if (v == null || (isObj(v) && Object.keys(v).length === 0)) return [[...prefix, k]];
    return leafPaths(v, [...prefix, k]);
  });
}

function children(node) { return isObj(node?.states) ? node.states : null; }

function initialValue(node) {
  const ch = children(node);
  if (!ch) return null;
  if (node.type === 'parallel') {
    const out = {};
    for (const [r, rn] of Object.entries(ch)) {
      const v = children(rn) ? initialValue(rn) : null;
      if (v === undefined) return undefined;
      out[r] = v ?? {};
    }
    return out;
  }
  const init = typeof node.initial === 'string' ? node.initial : Object.keys(ch)[0];
  const child = ch[init];
  if (!child) return undefined;
  if (!children(child)) return init;
  const v = initialValue(child);
  return v === undefined ? undefined : { [init]: v };
}

/** Assemble a configuration below `node` from paths relative to it; undefined = invalid. */
function build(node, paths) {
  const ch = children(node);
  if (!ch) return paths.every((p) => p.length === 0) ? null : undefined;
  const nonEmpty = paths.filter((p) => p.length > 0);
  if (node.type === 'parallel') {
    for (const p of nonEmpty) if (!ch[p[0]]) return undefined;
    const out = {};
    for (const [r, rn] of Object.entries(ch)) {
      const sub = nonEmpty.filter((p) => p[0] === r).map((p) => p.slice(1));
      const v = sub.length ? build(rn, sub) : (children(rn) ? initialValue(rn) : null);
      if (v === undefined) return undefined;
      out[r] = v ?? {};
    }
    return out;
  }
  if (nonEmpty.length === 0) return initialValue(node);
  const heads = [...new Set(nonEmpty.map((p) => p[0]))];
  if (heads.length !== 1) return undefined;             // two different children: conflict
  const h = heads[0];
  const child = ch[h];
  if (!child) return undefined;                          // the state does not exist
  const rests = nonEmpty.map((p) => p.slice(1));
  if (!children(child)) return rests.every((p) => p.length === 0) ? h : undefined;
  const v = build(child, rests);
  return v === undefined ? undefined : { [h]: v };
}

function mapLeaf(path, stateMapping) {
  for (let i = path.length; i >= 1; i--) {
    const key = path.slice(0, i).join('.');
    if (Object.prototype.hasOwnProperty.call(stateMapping, key)) {
      const to = stateMapping[key];
      if (typeof to !== 'string' || to.length === 0) return null;
      return to.split('.');
    }
  }
  return path;
}

/**
 * @param currentStateValue  the actor's configuration in the old definition
 * @param newMachineStates   the new definition's top-level `states`
 * @param stateMapping       { "old.path": "new.path" } (optional)
 * @returns the landing configuration, or null if the actor cannot be placed
 */
export function resolveLandingState(currentStateValue, newMachineStates, stateMapping = {}) {
  const leaves = leafPaths(currentStateValue);
  if (leaves.length === 0 || !isObj(newMachineStates)) return null;
  const mapped = [];
  for (const leaf of leaves) {
    const m = mapLeaf(leaf, stateMapping ?? {});
    if (!m) return null;
    mapped.push(m);
  }
  const v = build({ states: newMachineStates }, mapped);
  return v === undefined || v === null ? null : v;
}

/** All leaf paths (dot strings) of a definition — the configurations μ must cover. */
export function allLeafPaths(states, prefix = []) {
  const out = [];
  for (const [k, node] of Object.entries(states ?? {})) {
    const ch = children(node);
    if (ch) out.push(...allLeafPaths(ch, [...prefix, k]));
    else out.push([...prefix, k].join('.'));
  }
  return out;
}

/**
 * Can a leaf of the old definition be placed in the new one? (Per-leaf check: a
 * configuration is placeable iff each of its leaves is and no two conflict.)
 */
export function leafMappable(leafPath, newMachineStates, stateMapping = {}) {
  const m = mapLeaf(String(leafPath).split('.'), stateMapping ?? {});
  if (!m) return false;
  return build({ states: newMachineStates }, [m]) !== undefined;
}

function nodeAt(states, path) {
  let node = { states };
  for (const seg of path) { node = children(node)?.[seg]; if (!node) return null; }
  return node;
}

/**
 * Every configuration of the old definition that the mapping cannot place in the new one,
 * as the leaves that cannot be placed at all and the pairs of co-active leaves (leaves in
 * different regions of a parallel state) that conflict. A configuration is placeable iff
 * each of its leaves is and no two of them conflict (assembly only fails pairwise: two
 * leaves entering different children of one compound state), so this is exact.
 */
export function unplaceableConfigurations(oldStates, newStates, stateMapping = {}) {
  const leaves = allLeafPaths(oldStates);
  const badLeaves = leaves.filter((l) => !leafMappable(l, newStates, stateMapping));
  const ok = leaves.filter((l) => !badLeaves.includes(l));
  const badPairs = [];
  for (let i = 0; i < ok.length; i++) {
    const a = ok[i].split('.');
    for (let j = i + 1; j < ok.length; j++) {
      const b = ok[j].split('.');
      let k = 0;
      while (k < a.length && k < b.length && a[k] === b[k]) k++;
      if (k === 0) continue;                                   // top-level: never co-active
      if (nodeAt(oldStates, a.slice(0, k))?.type !== 'parallel') continue;
      const ma = mapLeaf(a, stateMapping ?? {}), mb = mapLeaf(b, stateMapping ?? {});
      if (build({ states: newStates }, [ma, mb]) === undefined) badPairs.push([ok[i], ok[j]]);
    }
  }
  return { leaves: badLeaves, pairs: badPairs };
}
