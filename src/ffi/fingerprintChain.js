export const FNV_PRIME = 0x00000100000001B3n;
export const FNV_OFFSET = 0xcbf29ce484222325n;
export const UINT64_MAX = 0xFFFFFFFFFFFFFFFFn;

export function bigIntToHex64(value) {
  return (BigInt(value) & UINT64_MAX).toString(16).padStart(16, '0');
}

function fnv1aUpdate(hash, value) {
  const buf = Buffer.from(String(value), 'utf8');
  let h = hash;
  for (const byte of buf) {
    h = ((h ^ BigInt(byte)) * FNV_PRIME) & UINT64_MAX;
  }
  return h;
}

export function computeHistoryFingerprint(eventTypes) {
  if (!eventTypes || eventTypes.length === 0) return bigIntToHex64(FNV_OFFSET);
  let h = FNV_OFFSET;
  for (const eventType of eventTypes) h = fnv1aUpdate(h, eventType);
  return bigIntToHex64(h);
}

export function updateFingerprint(currentHex, eventType) {
  const current = (!currentHex || currentHex === '0')
    ? FNV_OFFSET
    : BigInt(`0x${String(currentHex).padStart(16, '0')}`);
  return bigIntToHex64(fnv1aUpdate(current, eventType));
}
