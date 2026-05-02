/**
 * test/e2e/health.spec.js
 *
 * Block 3 — Health / worker-heartbeat endpoint tests:
 *  1. GET /v1/health/workers returns the expected response shape
 *  2. GET /v1/health/workers is publicly accessible (no API key required)
 *  3. worker_heartbeats table exists in the database schema
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.STATEKEEP_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;

// ── 1: /v1/health/workers returns correct shape ───────────────────────────────

test('GET /v1/health/workers returns expected response shape', async () => {
  const res  = await fetch(`${BASE}/v1/health/workers`);
  const body = await res.json();

  // 200 when all workers healthy (or none registered); 503 when any stale
  expect([200, 503]).toContain(res.status);
  expect(typeof body.healthy).toBe('boolean');
  expect(typeof body.checkedAt).toBe('number');
  expect(typeof body.staleThresholdMs).toBe('number');
  expect(Array.isArray(body.workers)).toBe(true);
});

// ── 2: /v1/health/workers is public (no key required) ────────────────────────

test('GET /v1/health/workers is publicly accessible without an API key', async () => {
  // Deliberately omit x-api-key — should never see 401 or 403
  const res = await fetch(`${BASE}/v1/health/workers`);
  expect(res.status).not.toBe(401);
  expect(res.status).not.toBe(403);
  // Endpoint responds with either 200 (all healthy) or 503 (some stale), never auth errors
  expect([200, 503]).toContain(res.status);
});

// ── 3: worker_heartbeats table exists ────────────────────────────────────────

test('worker_heartbeats table exists and the endpoint does not 500', async () => {
  // If the table were missing, the DB query would throw and the server would
  // return a 500. A non-500 response proves the table is present.
  const res  = await fetch(`${BASE}/v1/health/workers`);
  const body = await res.json();

  expect(res.status).not.toBe(500);
  expect(body).toHaveProperty('workers');
  expect(body).toHaveProperty('staleThresholdMs');
});
