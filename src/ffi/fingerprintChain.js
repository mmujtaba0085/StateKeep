// FNV-1a 32-bit — uses Math.imul for native CPU integer path (~5x faster than BigInt).
// Actor history fingerprints are keyed only on event *type*, never payload, so that
// historyPath declarations in definitions remain writable.

export const FNV32_PRIME  = 0x01000193;
export const FNV32_OFFSET = 0x811c9dc5;

// Backward-compat aliases (some callers import FNV_OFFSET / FNV_PRIME)
export const FNV_PRIME  = FNV32_PRIME;
export const FNV_OFFSET = FNV32_OFFSET;

/** Serialize a 32-bit unsigned integer to an 8-char lowercase hex string. */
export function bigIntToHex64(value) {
  return (value >>> 0).toString(16).padStart(8, '0');
}

function fnv1aUpdate(hash, value) {
  const buf = Buffer.from(String(value), 'utf8');
  let h = hash;
  for (const byte of buf) {
    h = Math.imul(h ^ byte, FNV32_PRIME) >>> 0;
  }
  return h;
}

export function computeHistoryFingerprint(eventTypes) {
  if (!eventTypes || eventTypes.length === 0) return bigIntToHex64(FNV32_OFFSET);
  let h = FNV32_OFFSET;
  for (const eventType of eventTypes) h = fnv1aUpdate(h, eventType);
  return bigIntToHex64(h);
}

export function updateFingerprint(currentHex, eventType) {
  const current = (!currentHex || currentHex === '0')
    ? FNV32_OFFSET
    : (parseInt(String(currentHex), 16) >>> 0);
  return bigIntToHex64(fnv1aUpdate(current, eventType));
}
