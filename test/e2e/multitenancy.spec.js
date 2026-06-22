/**
 * test/e2e/multitenancy.spec.js
 *
 * Verifies org management endpoints and cross-org data isolation.
 *
 * Admin endpoints work in test mode (adminMiddleware checks X-Admin-Key
 * regardless of NODE_ENV). /v1/auth/verify is public and always does a
 * real DB lookup.
 */

import { test, expect } from '@playwright/test';
import { uniqueId } from './helpers/api.js';

const BASE      = process.env.STATEKEEP_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;
const ADMIN_KEY = process.env.STATEKEEP_ADMIN_KEY ?? 'test-admin-key';

// Open-source mode: org management (/v1/orgs) and auth/verify are removed.
test.beforeEach(async ({}, testInfo) => {
  testInfo.skip(true, 'Multi-tenancy management removed in open-source mode');
});
const API_KEY   = process.env.STATEKEEP_API_KEY   ?? '';

const SENTINEL = '__test_key_do_not_use_in_production__';

async function adminPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': SENTINEL, 'x-admin-key': ADMIN_KEY },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function adminGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'x-api-key': SENTINEL, 'x-admin-key': ADMIN_KEY },
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function publicPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

// ── 1. Admin key gate ─────────────────────────────────────────────────────────

test('GET /v1/orgs without admin key returns 403', async () => {
  const res = await fetch(`${BASE}/v1/orgs`, {
    headers: { 'x-api-key': SENTINEL },
  });
  expect(res.status).toBe(403);
});

// ── 2. Org creation ───────────────────────────────────────────────────────────

test('POST /v1/orgs creates a new organisation', async () => {
  const name = uniqueId('acme');
  const { status, body } = await adminPost('/v1/orgs', { name });
  expect(status).toBe(201);
  expect(body.id).toBeTruthy();
  expect(body.name).toBe(name);
});

// ── 3. Org list ───────────────────────────────────────────────────────────────

test('GET /v1/orgs lists all orgs including newly created one', async () => {
  const name = uniqueId('listed-org');
  await adminPost('/v1/orgs', { name });

  const { status, body } = await adminGet('/v1/orgs');
  expect(status).toBe(200);
  expect(Array.isArray(body.orgs)).toBe(true);
  expect(body.orgs.some(o => o.name === name)).toBe(true);
});

// ── 4. Key provisioning ───────────────────────────────────────────────────────

test('POST /v1/orgs/:orgId/keys provisions an API key scoped to that org', async () => {
  const { body: org } = await adminPost('/v1/orgs', { name: uniqueId('key-org') });
  expect(org.id).toBeTruthy();

  const { status, body } = await adminPost(`/v1/orgs/${org.id}/keys`, {
    label: 'integration-test',
    tier:  'pro',
  });
  expect(status).toBe(201);
  expect(body.rawKey).toMatch(/^sk_[0-9a-f]{8}_[0-9a-f]{40}$/);
  expect(body.orgId).toBe(org.id);

  // Verify the key is listed under that org
  const { body: keys } = await adminGet(`/v1/orgs/${org.id}/keys`);
  expect(keys.keys.some(k => k.key_id === body.keyId)).toBe(true);
});

// ── 5. Auth verify — valid key ────────────────────────────────────────────────

test('POST /v1/auth/verify returns valid=true and orgId for the bootstrap key', async () => {
  if (!API_KEY || !API_KEY.startsWith('sk_')) return; // skip if no real key seeded
  const { status, body } = await publicPost('/v1/auth/verify', { apiKey: API_KEY });
  expect(status).toBe(200);
  expect(body.valid).toBe(true);
  expect(body.orgId).toBe('default');
  expect(body.tier).toBe('enterprise');
});

// ── 6. Auth verify — invalid key ─────────────────────────────────────────────

test('POST /v1/auth/verify returns 401 for an unknown key', async () => {
  const { status, body } = await publicPost('/v1/auth/verify', {
    apiKey: 'sk_deadbeef_0000000000000000000000000000000000000000',
  });
  expect(status).toBe(401);
  expect(body.error).toBeTruthy();
});
