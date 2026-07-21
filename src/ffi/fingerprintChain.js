// FNV-1a 64-bit — matches the C engine exactly.
// Actor history fingerprints are keyed only on event *type*, never payload, so that
// historyPath declarations in definitions remain writable.

export const FNV64_PRIME  = 0x00000100000001b3n;
export const FNV64_OFFSET = 0xcbf29ce484222325n;

export function bigIntToHex64(value) {
  return (BigInt(value) & 0xFFFFFFFFFFFFFFFFn).toString(16).padStart(16, '0');
}

function fnv1aUpdate(hash, value) {
  const buf = Buffer.from(String(value), 'utf8');
  let h = hash;
  for (const byte of buf) {
    h = ((h ^ BigInt(byte)) * FNV64_PRIME) & 0xFFFFFFFFFFFFFFFFn;
  }
  return h;
}

export function computeHistoryFingerprint(eventTypes) {
  if (!eventTypes || eventTypes.length === 0) return bigIntToHex64(FNV64_OFFSET);
  let h = FNV64_OFFSET;
  for (const eventType of eventTypes) h = fnv1aUpdate(h, eventType);
  return bigIntToHex64(h);
}

export function updateFingerprint(currentHex, eventType) {
  const current = (!currentHex || currentHex === '0')
    ? FNV64_OFFSET
    : BigInt(`0x${currentHex.padStart(16, '0')}`);
  return bigIntToHex64(fnv1aUpdate(current, eventType));
}
