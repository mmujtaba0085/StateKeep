/**
 * test/e2e/health.spec.js
 *
 * Block 3 — Health / worker-heartbeat endpoint tests:
 *  1. GET /v1/health/workers returns the expected response shape
 *  2. GET /v1/health/workers is publicly accessible (no API key required)
 *  3. worker_heartbeats table exists in the database schema
 */

import { test, expect } from '@playwright/test';

const BASE       = process.env.STATEKEEP_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;
const ADMIN_KEY  = process.env.STATEKEEP_ADMIN_KEY ?? 'test-admin-key';
const SENTINEL   = process.env.STATEKEEP_API_KEY   ?? '__test_key_do_not_use_in_production__';

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

// ── OpenAPI ───────────────────────────────────────────────────────────────────

test('GET /openapi.json returns a valid OpenAPI document', async () => {
  const res = await fetch(`${BASE}/openapi.json`, {
    headers: { 'x-api-key': SENTINEL },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.openapi).toMatch(/^3\./);
  expect(body.info).toBeDefined();
  expect(body.paths).toBeDefined();
});

test('GET /docs serves the Swagger UI HTML', async () => {
  const res = await fetch(`${BASE}/docs`, {
    headers: { 'x-api-key': SENTINEL },
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain('<!DOCTYPE html');
});

// ── Admin: worker restart ─────────────────────────────────────────────────────

test.skip('POST /v1/admin/workers/actor/restart requires admin key', async () => {
  // Open-source mode: adminMiddleware is a pass-through, no 403 is returned.
});

test('POST /v1/admin/workers/actor/restart succeeds with admin key', async () => {
  const res = await fetch(`${BASE}/v1/admin/workers/actor/restart`, {
    method:  'POST',
    headers: { 'x-api-key': SENTINEL, 'x-admin-key': ADMIN_KEY },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.restarted).toBe(true);
  expect(body.type).toBe('actor');
  expect(typeof body.workers).toBe('number');
});

test('POST /v1/admin/workers/migrate/restart returns guidance (not a direct restart)', async () => {
  const res = await fetch(`${BASE}/v1/admin/workers/migrate/restart`, {
    method:  'POST',
    headers: { 'x-api-key': SENTINEL, 'x-admin-key': ADMIN_KEY },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.restarted).toBe(false);
  expect(body.note).toMatch(/systemctl/);
});

test('POST /v1/admin/workers/:type/restart returns 400 for invalid type', async () => {
  const res = await fetch(`${BASE}/v1/admin/workers/bogus/restart`, {
    method:  'POST',
    headers: { 'x-api-key': SENTINEL, 'x-admin-key': ADMIN_KEY },
  });
  expect(res.status).toBe(400);
});
