const url = process.env.STATEKEEP_URL;
const apiKey = process.env.STATEKEEP_API_KEY || null;

async function checkOnce(target) {
  try {
    const headers = apiKey ? { 'X-API-Key': apiKey } : undefined;
    const res = await fetch(target, { method: 'GET', headers });
    if (res.ok) return true;
    return false;
  } catch (e) {
    return false;
  }
}

async function main() {
  if (!url) {
    console.log('STATEKEEP_URL not set — skipping StateKeep precheck.');
    process.exit(0);
  }

  console.log(`Prechecking StateKeep at ${url} ...`);
  const candidates = [ '/health', '/v1/health', '/' ].map(p => url.replace(/\/+$/, '') + p);
  const maxAttempts = 5;

  for (const candidate of candidates) {
    for (let i = 0; i < maxAttempts; i++) {
      const ok = await checkOnce(candidate);
      if (ok) {
        console.log(`OK: ${candidate}`);
        process.exit(0);
      }
      const backoff = 500 * Math.pow(2, i);
      await new Promise(r => setTimeout(r, backoff));
    }
  }

  console.error(`StateKeep precheck failed: could not reach ${url} (tried /health, /v1/health, /).`);
  process.exit(2);
}

main();
