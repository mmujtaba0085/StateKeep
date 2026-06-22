/**
 * Tier 3: StateKeep — full HTTP API + SQLite + worker pool.
 *
 * Measures end-to-end event throughput through the entire StateKeep stack:
 *   HTTP request → Fastify → authMiddleware → workerPool (priority queue)
 *   → actorWorker (XState + APV + write buffer) → SQLite → HTTP response
 *
 * Run sequentially (one request at a time) to measure single-actor latency.
 * Run concurrently (N parallel requests) to measure server throughput.
 */

const BASE = process.env.STATEKEEP_URL ?? 'http://localhost:3001';
const KEY  = process.env.STATEKEEP_API_KEY ?? '';

const DEF_ID = `bench-order-${Date.now()}`;
const MACHINE_DEF = {
  id: 'order',
  initial: 'idle',
  states: {
    idle:       { on: { PROCESS:  'processing' } },
    processing: { on: { COMPLETE: 'done'       } },
    done:       { on: { RESET:    'idle'        } },
  },
};

const HEADERS = {
  'Content-Type': 'application/json',
  ...(KEY ? { 'x-api-key': KEY } : {}),
};

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return json;
}

export async function checkServer() {
  try {
    const h = await fetch(`${BASE}/v1/health`, { signal: AbortSignal.timeout(3000) });
    if (!h.ok) return null;
    return await h.json();
  } catch {
    return null;
  }
}

async function setup() {
  // Deploy definition
  await api('PUT', '/v1/definitions', { id: DEF_ID, definition: MACHINE_DEF });
  // Spawn a single actor for sequential benchmark
  const actor = await api('POST', '/v1/actors', { definitionId: DEF_ID });
  return actor.id;
}

const CYCLE_EVENTS = ['PROCESS', 'COMPLETE', 'RESET'];

export async function run({ warmupCycles = 10, measureCycles = 200 } = {}) {
  const actorId = await setup();

  // Warm up
  for (let i = 0; i < warmupCycles; i++) {
    for (const type of CYCLE_EVENTS) {
      await api('POST', `/v1/actors/${actorId}/event`, { type });
    }
  }

  const latencies = new Float64Array(measureCycles * CYCLE_EVENTS.length);
  let idx = 0;

  const t0 = performance.now();
  for (let i = 0; i < measureCycles; i++) {
    for (const type of CYCLE_EVENTS) {
      const s = performance.now();
      await api('POST', `/v1/actors/${actorId}/event`, { type });
      latencies[idx++] = performance.now() - s;
    }
  }
  const elapsed = performance.now() - t0;

  return buildResult('StateKeep', `HTTP+SQLite+workers @ ${BASE}`, elapsed, latencies);
}

export async function runConcurrent({ concurrency = 10, eventsPerActor = 30 } = {}) {
  // Spawn N actors
  const actorIds = await Promise.all(
    Array.from({ length: concurrency }, () => api('POST', '/v1/actors', { definitionId: DEF_ID }).then(r => r.id))
  );

  // Warm up all actors through one cycle
  await Promise.all(actorIds.map(id =>
    (async () => {
      for (const type of CYCLE_EVENTS) await api('POST', `/v1/actors/${id}/event`, { type });
    })()
  ));

  const totalEvents = concurrency * eventsPerActor;
  const t0 = performance.now();

  await Promise.all(actorIds.map(id =>
    (async () => {
      const cycles = Math.floor(eventsPerActor / CYCLE_EVENTS.length);
      for (let i = 0; i < cycles; i++) {
        for (const type of CYCLE_EVENTS) {
          await api('POST', `/v1/actors/${id}/event`, { type });
        }
      }
    })()
  ));

  const elapsed  = performance.now() - t0;
  const evPerSec = Math.round(totalEvents / (elapsed / 1000));
  return { label: `StateKeep (${concurrency} concurrent actors)`, evPerSec, elapsedMs: elapsed, totalEvents };
}

function buildResult(label, note, elapsedMs, latencies) {
  const sorted   = Float64Array.from(latencies).sort();
  const total    = latencies.length;
  const evPerSec = Math.round(total / (elapsedMs / 1000));
  const p50      = sorted[Math.floor(total * 0.50)] * 1000;
  const p95      = sorted[Math.floor(total * 0.95)] * 1000;
  const p99      = sorted[Math.floor(total * 0.99)] * 1000;
  return { label, note, evPerSec, p50, p95, p99, totalEvents: total, elapsedMs };
}
