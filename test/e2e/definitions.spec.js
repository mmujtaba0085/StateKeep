/**
 * test/e2e/definitions.spec.js
 * E2E tests for definition deploy, versioning, stats, and machine endpoints.
 */

import { test, expect } from '@playwright/test';
import { GET, POST, PUT, SIMPLE_MACHINE, SIMPLE_MACHINE_V2, uniqueId } from './helpers/api.js';

test('deploy a root definition returns 201', async () => {
  const id  = uniqueId('def-root');
  const res = await PUT('/v1/definitions', { id, definition: SIMPLE_MACHINE });
  const ok = res.status >= 200 && res.status < 300;
  expect(ok, `HTTP ${res.status}: ${JSON.stringify(res.body)}`).toBe(true);
  expect(res.body.id).toBe(id);
});

test('deploying same id twice is idempotent', async () => {
  const id = uniqueId('def-idem');
  await PUT('/v1/definitions', { id, definition: SIMPLE_MACHINE });
  const res = await PUT('/v1/definitions', { id, definition: SIMPLE_MACHINE });
  expect(res.status).toBe(200);
  expect(res.body.idempotent).toBe(true);
});

test('PUT with dryRun=true returns preview without writing', async () => {
  const id  = uniqueId('def-dry');
  const res = await PUT('/v1/definitions?dryRun=true', {
    id, parentId: uniqueId('ghost'), definition: SIMPLE_MACHINE,
  });
  expect(res.status).toBe(200);
  expect(res.body.dryRun).toBe(true);
  expect(res.body.valid).toBe(true);
});

test('deploy invalid definition returns 400', async () => {
  const id  = uniqueId('def-invalid');
  const res = await PUT('/v1/definitions', {
    id,
    definition: { initial: 'nonexistent', states: { idle: {} } },
  });
  expect(res.status).toBe(400);
  expect(res.body.errors).toBeTruthy();
});

test('GET /v1/definitions/:id/status returns deployment info', async () => {
  const id = uniqueId('def-status');
  await PUT('/v1/definitions', { id, definition: SIMPLE_MACHINE });
  const res = await GET(`/v1/definitions/${id}/status`);
  expect(res.status).toBe(200);
  expect(res.body.definition.id).toBe(id);
});

test('GET /v1/definitions/:id/diff returns state diff', async () => {
  const rootId = uniqueId('def-diff-root');
  const childId = uniqueId('def-diff-child');

  await PUT('/v1/definitions', { id: rootId, definition: SIMPLE_MACHINE });
  await PUT('/v1/definitions', { id: childId, parentId: rootId, definition: SIMPLE_MACHINE_V2 });

  const res = await GET(`/v1/definitions/${childId}/diff`);
  expect(res.status).toBe(200);
  expect(res.body.diff.statesAdded).toContain('cancelled');
});

test('GET /v1/definitions/:id/stats returns active actor counts', async () => {
  const defId = uniqueId('def-stats');
  await PUT('/v1/definitions', { id: defId, definition: SIMPLE_MACHINE });

  // Spawn a couple of actors
  await POST('/v1/actors', { definitionId: defId });
  await POST('/v1/actors', { definitionId: defId });

  const res = await GET(`/v1/definitions/${defId}/stats`);
  expect(res.status).toBe(200);
  expect(res.body.totalActive).toBeGreaterThanOrEqual(2);
});

test('GET /v1/machines/:id/stats returns family stats', async () => {
  const rootId = uniqueId('machine-stats-root');
  await PUT('/v1/definitions', { id: rootId, definition: SIMPLE_MACHINE });

  await POST('/v1/actors', { definitionId: rootId });

  const res = await GET(`/v1/machines/${rootId}/stats`);
  expect(res.status).toBe(200);
  expect(res.body.machineId).toBe(rootId);
  expect(res.body.versions.length).toBeGreaterThanOrEqual(1);
  expect(res.body.totalActive).toBeGreaterThanOrEqual(1);
});

test('POST /v1/definitions/preview returns migration analysis', async () => {
  const parentId = uniqueId('def-preview-parent');
  await PUT('/v1/definitions', { id: parentId, definition: SIMPLE_MACHINE });

  const res = await POST('/v1/definitions/preview', {
    parentId,
    definition: SIMPLE_MACHINE_V2,
  });
  expect(res.status).toBe(200);
  expect(res.body.dryRun).toBe(true);
  expect(res.body.valid).toBe(true);
  expect(res.body.migration).toBeTruthy();
});

test('GET /v1/definitions lists all definitions', async () => {
  const res = await GET('/v1/definitions');
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.definitions)).toBe(true);
});
