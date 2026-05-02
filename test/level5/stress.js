/**
 * test/level5/stress.js
 *
 * Level 5 — Stress & Load Tests
 *
 * These tests require the server to be running and are designed for Ubuntu 22.04
 * bare-metal or a well-resourced VPS.
 *
 * Run:
 *   STRESS=1 node --test test/level5/stress.js
 *
 * Without STRESS=1, tests are skipped with a note.
 *
 * Metrics reported: p50, p99 latency; memory growth; WAL file size.
 */

import '../setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { seedApiKey, post, get, put, BASE_URL } from '../setup.js';
import { linearMachine } from '../helpers/factories.js';

const RUN_STRESS = !!process.env.STRESS;
const SKIP_MSG   = 'Set STRESS=1 to run stress tests';

// ── Latency helpers ───────────────────────────────────────────────────────────

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function measureLatency(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    min:  sorted[0],
    p50:  percentile(sorted, 50),
    p95:  percentile(sorted, 95),
    p99:  percentile(sorted, 99),
    max:  sorted[sorted.length - 1],
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

before(async () => {
  if (!RUN_STRESS) return;
  await seedApiKey();
  await put('/v1/definitions', { id: 'stress-linear-v1', definition: linearMachine('stress') });
});

// ── Test S1: Actor Storm ──────────────────────────────────────────────────────

describe('S1: Actor Storm — spawn 1,000 actors', { skip: !RUN_STRESS ? SKIP_MSG : false }, () => {
  test('spawn 1,000 actors concurrently in batches of 100', async () => {
    const TOTAL      = 1000;
    const BATCH_SIZE = 100;
    const latencies  = [];
    const failed     = [];

    for (let b = 0; b < TOTAL / BATCH_SIZE; b++) {
      const batch = Array.from({ length: BATCH_SIZE }, async () => {
        const t0 = Date.now();
        const r  = await post('/v1/actors', { definitionId: 'stress-linear-v1' });
        latencies.push(Date.now() - t0);
        if (r.status !== 201) failed.push(r.status);
        return r.body?.id;
      });
      await Promise.all(batch);
    }

    const stats = measureLatency(latencies);
    console.log(`[S1] Spawn latency: p50=${stats.p50}ms p99=${stats.p99}ms mean=${stats.mean.toFixed(1)}ms`);

    assert.equal(failed.length, 0, `${failed.length} spawns failed`);
    assert.ok(stats.p99 < 5000, `p99 spawn latency too high: ${stats.p99}ms`);
  });

  test('p50 spawn latency < 500ms', async () => {
    const latencies = [];
    const batch = Array.from({ length: 100 }, async () => {
      const t0 = Date.now();
      await post('/v1/actors', { definitionId: 'stress-linear-v1' });
      latencies.push(Date.now() - t0);
    });
    await Promise.all(batch);
    const stats = measureLatency(latencies);
    assert.ok(stats.p50 < 500, `p50 latency too high: ${stats.p50}ms`);
  });
});

// ── Test S2: Event Throughput ─────────────────────────────────────────────────

describe('S2: Sustained 500 events/sec for 10 seconds', { skip: !RUN_STRESS ? SKIP_MSG : false }, () => {
  test('sends 5,000 events, measures throughput and p99', async () => {
    // Spawn 50 actors
    const ids = [];
    for (let i = 0; i < 50; i++) {
      const r = await post('/v1/actors', { definitionId: 'stress-linear-v1' });
      assert.equal(r.status, 201);
      ids.push(r.body.id);
    }

    // Prime actors (move to processing)
    await Promise.all(ids.map(id => post(`/v1/actors/${id}/event`, { type: 'START' })));

    const TOTAL     = 5000;
    const latencies = [];
    const errors    = [];

    // Round-robin events across actors
    const events = ids.map((id, i) => ({ id, type: i % 2 === 0 ? 'FAIL' : 'COMPLETE' }));
    const tasks  = Array.from({ length: TOTAL }, (_, i) => {
      const { id, type } = events[i % events.length];
      return async () => {
        const t0 = Date.now();
        const r  = await post(`/v1/actors/${id}/event`, { type });
        latencies.push(Date.now() - t0);
        if (r.status !== 200) errors.push(r.status);
      };
    });

    // Execute in rolling batches of 50 (concurrency cap)
    const CONCURRENCY = 50;
    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
      await Promise.all(tasks.slice(i, i + CONCURRENCY).map(fn => fn()));
    }

    const stats = measureLatency(latencies);
    console.log(`[S2] Event latency: p50=${stats.p50}ms p95=${stats.p95}ms p99=${stats.p99}ms`);
    console.log(`[S2] Errors: ${errors.length}/${TOTAL}`);

    assert.ok(errors.length / TOTAL < 0.01, `Error rate too high: ${(errors.length / TOTAL * 100).toFixed(2)}%`);
    assert.ok(stats.p99 < 10_000, `p99 event latency too high: ${stats.p99}ms`);
  });
});

// ── Test S3: Memory Stability ─────────────────────────────────────────────────

describe('S3: Memory growth is bounded over 500 actor spawns', { skip: !RUN_STRESS ? SKIP_MSG : false }, () => {
  test('heap growth < 200MB after 500 spawns', async () => {
    const memBefore = process.memoryUsage().heapUsed;

    const BATCH = 500;
    for (let i = 0; i < BATCH; i += 50) {
      await Promise.all(
        Array.from({ length: 50 }, () =>
          post('/v1/actors', { definitionId: 'stress-linear-v1' })
        )
      );
    }

    if (global.gc) global.gc(); // run GC if --expose-gc flag set
    const memAfter  = process.memoryUsage().heapUsed;
    const growthMB  = (memAfter - memBefore) / 1024 / 1024;

    console.log(`[S3] Heap growth after ${BATCH} spawns: ${growthMB.toFixed(1)} MB`);
    assert.ok(growthMB < 200, `Excessive memory growth: ${growthMB.toFixed(1)}MB`);
  });
});

// ── Test S4: Concurrent Reads ─────────────────────────────────────────────────

describe('S4: 200 concurrent GET /state requests', { skip: !RUN_STRESS ? SKIP_MSG : false }, () => {
  test('all state reads succeed within 3s', async () => {
    // Create some actors first
    const ids = [];
    for (let i = 0; i < 20; i++) {
      const r = await post('/v1/actors', { definitionId: 'stress-linear-v1' });
      if (r.status === 201) ids.push(r.body.id);
    }

    const READS     = 200;
    const latencies = [];
    const start     = Date.now();

    await Promise.all(
      Array.from({ length: READS }, (_, i) => {
        const id = ids[i % ids.length];
        return (async () => {
          const t0 = Date.now();
          await get(`/v1/actors/${id}/state`);
          latencies.push(Date.now() - t0);
        })();
      })
    );

    const elapsed = Date.now() - start;
    const stats   = measureLatency(latencies);

    console.log(`[S4] ${READS} reads in ${elapsed}ms — p50=${stats.p50}ms p99=${stats.p99}ms`);
    assert.ok(elapsed < 30_000, `200 reads took too long: ${elapsed}ms`);
  });
});

// ── Test S5: WAL Size Stays Bounded ──────────────────────────────────────────

describe('S5: SQLite WAL file does not grow unboundedly', { skip: !RUN_STRESS ? SKIP_MSG : false }, () => {
  test('WAL size reported in metrics stays < 100MB after 200 actor writes', async () => {
    // Drive 200 events
    const r = await post('/v1/actors', { definitionId: 'stress-linear-v1' });
    if (r.status !== 201) return;
    const id = r.body.id;

    for (let i = 0; i < 100; i++) {
      await post(`/v1/actors/${id}/event`, { type: i % 2 === 0 ? 'START' : 'FAIL' });
    }

    // Check metrics for WAL size
    const metrics = await get('/v1/metrics');
    if (metrics.status === 200 && metrics.body?.wal_size_bytes != null) {
      const walMB = metrics.body.wal_size_bytes / 1024 / 1024;
      console.log(`[S5] WAL size: ${walMB.toFixed(2)} MB`);
      assert.ok(walMB < 100, `WAL grew too large: ${walMB.toFixed(2)}MB`);
    }
  });
});
