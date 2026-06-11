export const REGION_FINGERPRINTS_VERSION = 2;

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRegionMap(regionFingerprints) {
  if (!isPlainObject(regionFingerprints)) return null;

  const entries = Object.entries(regionFingerprints)
    .filter(([regionPath, fingerprint]) => (
      typeof regionPath === 'string' &&
      regionPath.length > 0 &&
      typeof fingerprint === 'string' &&
      fingerprint.length > 0
    ))
    .sort(([a], [b]) => a.localeCompare(b));

  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function parsePayload(payload) {
  if (!payload) return null;
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export function serializeRegionFingerprints(regionFingerprints) {
  const regions = normalizeRegionMap(regionFingerprints);
  if (!regions) return null;
  return JSON.stringify({
    _v: REGION_FINGERPRINTS_VERSION,
    regions,
  });
}

export function isVersionedRegionFingerprintsPayload(payload) {
  const parsed = parsePayload(payload);
  return (
    isPlainObject(parsed) &&
    parsed._v === REGION_FINGERPRINTS_VERSION &&
    normalizeRegionMap(parsed.regions) !== null
  );
}

export function deserializeRegionFingerprints(payload) {
  const parsed = parsePayload(payload);
  if (
    !isPlainObject(parsed) ||
    parsed._v !== REGION_FINGERPRINTS_VERSION
  ) {
    return null;
  }
  return normalizeRegionMap(parsed.regions);
}
