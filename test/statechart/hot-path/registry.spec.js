import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadRegistry,
  validateDefinitionAgainstRegistry,
  StateKeep,
} from '../../../src/runtime/implementationRegistry.js';

describe('loadRegistry', () => {
  test('loads guards and validates they are sync', () => {
    const reg = loadRegistry({
      guards: { isReady: ({ context }) => context.ready === true },
      actions: {},
      services: {},
    });
    assert.ok(typeof reg.guards.isReady === 'function');
  });

  test('rejects async guards', () => {
    assert.throws(
      () => loadRegistry({ guards: { asyncGuard: async () => true }, actions: {}, services: {} }),
      /asyncGuard.*synchronous/i
    );
  });
});

describe('validateDefinitionAgainstRegistry', () => {
  test('returns empty array when all names present', () => {
    const compiled = {
      transitions: { 'idle:GO': [{ target: 'done', guard: 'isReady', actions: ['log'] }] },
      entryActions: { 'done': ['notify'] },
      exitActions: {},
      transientStates: {},
    };
    const reg = loadRegistry({
      guards: { isReady: () => true },
      actions: { log: () => {}, notify: () => {} },
      services: {},
    });
    const missing = validateDefinitionAgainstRegistry(compiled, reg);
    assert.deepEqual(missing, []);
  });

  test('returns missing names', () => {
    const compiled = {
      transitions: { 'a:EV': [{ target: 'b', guard: 'missingGuard', actions: ['missingAction'] }] },
      entryActions: {}, exitActions: {}, transientStates: {},
    };
    const reg = loadRegistry({ guards: {}, actions: {}, services: {} });
    const missing = validateDefinitionAgainstRegistry(compiled, reg);
    assert.ok(missing.includes('missingGuard'));
    assert.ok(missing.includes('missingAction'));
  });
});

describe('StateKeep.durable and StateKeep.invoke', () => {
  test('StateKeep.durable tags a function', () => {
    const fn = StateKeep.durable(async () => {}, { maxRetries: 3 });
    assert.ok(fn.__sk_durable, 'should have durable tag');
    assert.equal(fn.__sk_durable.maxRetries, 3);
  });

  test('StateKeep.invoke tags a service fn', () => {
    const fn = StateKeep.invoke(async () => 'result', { idempotent: true, timeout: 5000 });
    assert.ok(fn.__sk_invoke, 'should have invoke tag');
    assert.equal(fn.__sk_invoke.idempotent, true);
  });
});
