/**
 * sdk/test/client.test.js
 * Integration tests for StateKeepClient.
 * Runs against a live server — set STATEKEEP_URL and STATEKEEP_API_KEY, or
 * defaults to http://localhost:3001 with the standard test key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── The SDK is pure TypeScript — for these JS tests we call the compiled dist.
// Build first: cd sdk && npm run build
import { StateKeepClient, StateKeepRequestError } from '../dist/index.js';

const BASE_URL = process.env.STATEKEEP_URL ?? 'http://localhost:3001';
const API_KEY  = process.env.STATEKEEP_API_KEY ?? 'sk_ab12cd34_0000000000000000000000000000000000000000';

const client = new StateKeepClient({ baseUrl: BASE_URL, apiKey: API_KEY });

const SIMPLE_MACHINE = {
  initial: 'idle',
  states: {
    idle:    { on: { START: 'running' } },
    running: { on: { STOP: 'done' } },
    done:    { type: 'final' },
  },
};

let defId;
let actorId;

// ── Setup ──────────────────────────────────────────────────────────────────────

test('deployDefinition — creates a new definition', async () => {
  defId = `sdk-test-def-${Date.now()}`;
  const res = await client.deployDefinition({ id: defId, machineDefinition: SIMPLE_MACHINE });
  assert.ok(res.id, 'response should include id');
});

// ── Actors ─────────────────────────────────────────────────────────────────────

test('spawnActor — returns actor with initial state', async () => {
  const actor = await client.spawnActor({ definitionId: defId });
  assert.ok(actor.id, 'actor should have id');
  assert.equal(actor.stateValue, 'idle');
  assert.equal(actor.done, false);
  actorId = actor.id;
});

test('getActor — returns current actor state', async () => {
  const actor = await client.getActor(actorId);
  assert.equal(actor.id, actorId);
  assert.equal(actor.stateValue, 'idle');
  assert.equal(actor.done, false);
});

test('sendEvent — transitions actor state', async () => {
  const actor = await client.sendEvent(actorId, { type: 'START' });
  assert.equal(actor.stateValue, 'running');
  assert.equal(actor.done, false);
});

test('sendEvent — reaches final state and sets done=true', async () => {
  const actor = await client.sendEvent(actorId, { type: 'STOP' });
  assert.equal(actor.stateValue, 'done');
  assert.equal(actor.done, true);
});

test('listActorEvents — returns paginated event history', async () => {
  const result = await client.listActorEvents(actorId);
  assert.ok(Array.isArray(result.events));
  assert.ok(result.events.length >= 3); // SPAWN + START + STOP
  assert.ok(result.events.some(e => e.eventType === 'SPAWN'));
  assert.ok(result.events.some(e => e.eventType === 'START'));
});

test('bulkSpawnActors — spawns multiple actors in one call', async () => {
  const result = await client.bulkSpawnActors({
    actors: [
      { definitionId: defId },
      { definitionId: defId, initialContext: { tag: 'b' } },
    ],
  });
  assert.equal(result.created.length, 2);
  assert.equal(result.failed.length, 0);
  assert.equal(result.total, 2);
  for (const actor of result.created) {
    assert.ok(actor.id);
    assert.equal(actor.stateValue, 'idle');
  }
});

// ── Definitions ────────────────────────────────────────────────────────────────

test('getDefinition — retrieves deployed definition', async () => {
  const def = await client.getDefinition(defId);
  assert.equal(def.id, defId);
  assert.ok(def.machineDefinition);
});

// ── Webhooks ───────────────────────────────────────────────────────────────────

let webhookId;

test('createWebhook — registers a webhook endpoint', async () => {
  const wh = await client.createWebhook({
    url:    'https://example.com/hook',
    events: ['actor.transitioned'],
  });
  assert.ok(wh.id);
  assert.equal(wh.url, 'https://example.com/hook');
  webhookId = wh.id;
});

test('listWebhooks — includes created webhook', async () => {
  const result = await client.listWebhooks();
  assert.ok(Array.isArray(result.webhooks));
  assert.ok(result.webhooks.some(w => w.id === webhookId));
});

test('getWebhook — returns single webhook by id', async () => {
  const wh = await client.getWebhook(webhookId);
  assert.equal(wh.id, webhookId);
});

test('updateWebhook — marks webhook inactive', async () => {
  const wh = await client.updateWebhook(webhookId, { active: false });
  assert.equal(wh.active, false);
});

test('deleteWebhook — removes the webhook', async () => {
  await client.deleteWebhook(webhookId);
  // Confirm it is gone
  try {
    await client.getWebhook(webhookId);
    assert.fail('Expected 404 after delete');
  } catch (err) {
    assert.ok(err instanceof StateKeepRequestError);
    assert.equal(err.statusCode, 404);
  }
});

// ── Error handling ─────────────────────────────────────────────────────────────

test('StateKeepRequestError — thrown on 404 for unknown actor', async () => {
  try {
    await client.getActor('nonexistent-actor-xyz');
    assert.fail('Expected StateKeepRequestError');
  } catch (err) {
    assert.ok(err instanceof StateKeepRequestError);
    assert.equal(err.statusCode, 404);
  }
});
