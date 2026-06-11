import { updateFingerprint } from '../ffi/fingerprintChain.js';

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function dotPath(parts) {
  return parts.filter(Boolean).join('.');
}

function stateValuesEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => stateValuesEqual(item, b[index]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i += 1) {
      if (aKeys[i] !== bKeys[i]) return false;
      if (!stateValuesEqual(a[aKeys[i]], b[bKeys[i]])) return false;
    }
    return true;
  }
  return false;
}

export function flattenStateValue(value, prefix = []) {
  if (typeof value === 'string') return [dotPath([...prefix, value])];
  if (!isPlainObject(value)) return [];

  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') {
      paths.push(dotPath([...prefix, key, child]));
    } else {
      paths.push(...flattenStateValue(child, [...prefix, key]));
    }
  }
  return paths;
}

export function extractParallelRegionPaths(definition) {
  const paths = new Set();

  function visit(node, path) {
    if (!isPlainObject(node)) return;
    const states = isPlainObject(node.states) ? node.states : {};
    if (node.type === 'parallel') {
      for (const regionName of Object.keys(states)) {
        paths.add(dotPath([...path, regionName]));
      }
    }
    for (const [stateName, child] of Object.entries(states)) {
      visit(child, [...path, stateName]);
    }
  }

  visit(definition, []);
  return [...paths].sort();
}

export function getStateValueAtPath(stateValue, path) {
  if (!path) return stateValue;
  const segments = String(path).split('.').filter(Boolean);
  let current = stateValue;
  for (const segment of segments) {
    if (!isPlainObject(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function initializeRegionFingerprints(definition, stateValue, current = null) {
  const regionPaths = extractParallelRegionPaths(definition);
  if (regionPaths.length === 0) return null;

  const result = {};
  for (const regionPath of regionPaths) {
    if (getStateValueAtPath(stateValue, regionPath) !== undefined) {
      result[regionPath] = current?.[regionPath] ?? '0';
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export function updateRegionFingerprintsForTransition(
  definition,
  preStateValue,
  postStateValue,
  eventType,
  current = null
) {
  const regionPaths = extractParallelRegionPaths(definition);
  if (regionPaths.length === 0) return null;

  const result = {};
  for (const regionPath of regionPaths) {
    const postRegion = getStateValueAtPath(postStateValue, regionPath);
    if (postRegion === undefined) continue;

    const preRegion = getStateValueAtPath(preStateValue, regionPath);
    let fp = current?.[regionPath] ?? '0';
    if (preRegion !== undefined && !stateValuesEqual(preRegion, postRegion)) {
      fp = updateFingerprint(fp, eventType);
    }
    result[regionPath] = fp;
  }

  return Object.keys(result).length > 0 ? result : null;
}

export function normalizeHistoryRegions(historyRegions, definition) {
  if (!isPlainObject(historyRegions) || Object.keys(historyRegions).length === 0) {
    return null;
  }

  const regionPaths = extractParallelRegionPaths(definition);
  const regionSet = new Set(regionPaths);
  const byShortName = new Map();
  for (const regionPath of regionPaths) {
    const shortName = regionPath.split('.').at(-1);
    const matches = byShortName.get(shortName) ?? [];
    matches.push(regionPath);
    byShortName.set(shortName, matches);
  }

  const normalized = {};
  for (const [rawKey, events] of Object.entries(historyRegions)) {
    if (!Array.isArray(events) || events.some(event => typeof event !== 'string' || event.length === 0)) {
      throw new Error(`historyRegions.${rawKey} must be an array of non-empty event type strings`);
    }

    let regionPath = rawKey;
    if (!regionSet.has(rawKey)) {
      if (rawKey.includes('.')) {
        throw new Error(`Unknown parallel region path: ${rawKey}`);
      }
      const matches = byShortName.get(rawKey) ?? [];
      if (matches.length === 0) throw new Error(`Unknown parallel region: ${rawKey}`);
      if (matches.length > 1) {
        throw new Error(`Ambiguous parallel region "${rawKey}"; use one of: ${matches.join(', ')}`);
      }
      regionPath = matches[0];
    }

    normalized[regionPath] = [...events];
  }

  return Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)));
}
