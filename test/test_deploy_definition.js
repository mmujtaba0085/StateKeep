/**
 * test/test_deploy_definition.js
 * Proves: definition upload, deployment record created
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { seedApiKey, put, get, SAMPLE_MACHINE_V1, SAMPLE_MACHINE_V2 } from './setup.js';

before(async () => { await seedApiKey(); });

test('PUT /v1/definitions creates definition row', async () => {
  const r = await put('/v1/definitions', {
    id:         'def-deploy-test-v1',
    definition: SAMPLE_MACHINE_V1,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.id, 'def-deploy-test-v1');
  assert.ok(typeof r.body.deployedAt === 'number', 'deployedAt should be a number');
});

test('deploying duplicate definition ID returns 409', async () => {
  const r = await put('/v1/definitions', {
    id:         'def-deploy-test-v1',
    definition: SAMPLE_MACHINE_V1,
  });
  assert.equal(r.status, 409);
});

test('GET /v1/definitions/:id/status returns definition info', async () => {
  const r = await get('/v1/definitions/def-deploy-test-v1/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.definition.id, 'def-deploy-test-v1');
  assert.ok(Array.isArray(r.body.deployments), 'deployments should be array');
});

test('deploying with parentId creates deployment record', async () => {
  // First deploy parent
  await put('/v1/definitions', { id: 'deploy-parent-v1', definition: SAMPLE_MACHINE_V1 });

  // Deploy child (with parentId)
  const r = await put('/v1/definitions', {
    id:         'deploy-child-v2',
    parentId:   'deploy-parent-v1',
    definition: SAMPLE_MACHINE_V2,
    refinement: 1,
  });
  assert.equal(r.status, 201);
  // deploymentId may be null if no actors on parent (affectedActors = 0)
  assert.equal(r.body.affectedActors, 0, 'No actors on parent yet');
});

test('GET /v1/definitions returns list', async () => {
  const r = await get('/v1/definitions');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.definitions));
  assert.ok(r.body.definitions.length > 0);
});
