/**
 * test/statechart/sc16.batch-events.js
 *
 * Batch events HTTP endpoint — POST /v1/actors/:id/events/batch
 *
 *   SC16-A: Basic batch — events advance actor through states in order
 *   SC16-B: Stop-on-final — batch stops as soon as actor reaches a final state
 *   SC16-C: Idempotency key deduplication — same key in two successive calls is skipped
 *   SC16-D: Unknown actor returns 404
 *   SC16-E: Schema validation — empty events array or missing type field rejected
 *
 * Run: node --test test/statechart/sc16.batch-events.js
 * (requires server on port 3099)
 */

import '../setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { seedApiKey, post, put } from '../setup.js';

before(async () => { await seedApiKey(); });

// ── Shared machine ─────────────────────────────────────────────────────────────

const ORDER_MACHINE = {
  id: `order-batch-${Date.now()}`,
  initial: 'idle',
  states: {
    idle:       { on: { PROCESS: 'processing' } },
    processing: { on: { SHIP: 'shipped' } },
    shipped:    { on: { COMPLETE: 'done' } },
    done:       { type: 'final' },
  },
};

let defId;

before(async () => {
  await seedApiKey();
  const r = await put('/v1/definitions', { id: ORDER_MACHINE.id, definition: ORDER_MACHINE });
  assert.ok([200, 201].includes(r.status), `definition deploy failed: ${JSON.stringify(r.body)}`);
  defId = ORDER_MACHINE.id;
});

// ── SC16-A: Basic batch ────────────────────────────────────────────────────────

describe('SC16-A: basic batch — events advance actor in order', () => {
  test('three events in one call move actor through all states', async () => {
    const { body: actor } = await post('/v1/actors', { definitionId: defId });
    assert.ok(actor.id, 'actor should be spawned');
    assert.equal(actor.stateValue, 'idle');

    const r = await post(`/v1/actors/${actor.id}/events/batch`, {
      events: [
        { type: 'PROCESS' },
        { type: 'SHIP' },
        { type: 'COMPLETE' },
      ],
    });
    assert.equal(r.status, 200, `batch failed: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.actorId, actor.id);
    assert.equal(r.body.results.length, 3);
    assert.equal(r.body.results[0].stateValue, 'processing');
    assert.equal(r.body.results[0].done, false);
    assert.equal(r.body.results[1].stateValue, 'shipped');
    assert.equal(r.body.results[1].done, false);
    assert.equal(r.body.results[2].stateValue, 'done');
    assert.equal(r.body.results[2].done, true);
  });

  test('unknown event is silently ignored — stateValue unchanged', async () => {
    const { body: actor } = await post('/v1/actors', { definitionId: defId });

    const r = await post(`/v1/actors/${actor.id}/events/batch`, {
      events: [{ type: 'NONEXISTENT' }, { type: 'PROCESS' }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.results.length, 2);
    assert.equal(r.body.results[0].stateValue, 'idle',       'unknown event leaves state unchanged');
    assert.equal(r.body.results[1].stateValue, 'processing', 'subsequent event still processed');
  });
});

// ── SC16-B: Stop-on-final ─────────────────────────────────────────────────────

describe('SC16-B: stop-on-final — batch stops when actor reaches final state', () => {
  test('extra events after final are not processed', async () => {
    const { body: actor } = await post('/v1/actors', { definitionId: defId });

    // 5 events but actor reaches final at event 3
    const r = await post(`/v1/actors/${actor.id}/events/batch`, {
      events: [
        { type: 'PROCESS' },
        { type: 'SHIP' },
        { type: 'COMPLETE' },
        { type: 'PROCESS' },  // after final — must NOT be processed
        { type: 'SHIP' },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.results.length, 3, 'batch must stop after final state');
    assert.equal(r.body.results[2].done, true);
  });
});

// ── SC16-C: Idempotency key ───────────────────────────────────────────────────

describe('SC16-C: idempotency key deduplication', () => {
  test('event with same key in a second batch call is skipped', async () => {
    const { body: actor } = await post('/v1/actors', { definitionId: defId });
    const key = `idem-${actor.id}`;

    // First call — should process
    const r1 = await post(`/v1/actors/${actor.id}/events/batch`, {
      events: [{ type: 'PROCESS', idempotencyKey: key }],
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.results[0].stateValue, 'processing');

    // Second call with same key — must be skipped
    const r2 = await post(`/v1/actors/${actor.id}/events/batch`, {
      events: [{ type: 'PROCESS', idempotencyKey: key }],
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.results.length, 1);
    assert.ok(r2.body.results[0].skipped,          'duplicate key must be skipped');
    assert.equal(r2.body.results[0].idempotencyKey, key);
  });
});

// ── SC16-D: Unknown actor ─────────────────────────────────────────────────────

describe('SC16-D: unknown actor', () => {
  test('returns 404 for non-existent actor', async () => {
    const r = await post('/v1/actors/does-not-exist-xxx/events/batch', {
      events: [{ type: 'PROCESS' }],
    });
    assert.equal(r.status, 404);
  });
});

// ── SC16-E: Schema validation ──────────────────────────────────────────────────

describe('SC16-E: schema validation', () => {
  test('empty events array is rejected with 400', async () => {
    const { body: actor } = await post('/v1/actors', { definitionId: defId });
    const r = await post(`/v1/actors/${actor.id}/events/batch`, { events: [] });
    assert.ok([400, 422].includes(r.status), `expected 400/422, got ${r.status}`);
  });

  test('event missing type field is rejected with 400', async () => {
    const { body: actor } = await post('/v1/actors', { definitionId: defId });
    const r = await post(`/v1/actors/${actor.id}/events/batch`, {
      events: [{ payload: { foo: 1 } }],
    });
    assert.ok([400, 422].includes(r.status), `expected 400/422, got ${r.status}`);
  });
});
