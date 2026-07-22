// test/statechart/foundation.spec.js
// Pure-JS tests (no SQLite): node --test test/statechart/foundation.spec.js
// writeBuffer test requires WSL:  wsl node --test test/statechart/foundation.spec.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── stateKeyOf export ──────────────────────────────────────────────────────────
test('stateKeyOf is exported from interpreter.js', async () => {
  const { stateKeyOf } = await import('../../src/runtime/interpreter.js');
  assert.equal(typeof stateKeyOf, 'function', 'stateKeyOf must be exported');
  assert.equal(stateKeyOf('idle'), 'idle');
  assert.equal(stateKeyOf({ flow: 'step1' }), 'flow.step1');
  assert.equal(stateKeyOf({ a: { b: 'c' } }), 'a.b.c');
});

test('keyToStateValue is exported from interpreter.js', async () => {
  const { keyToStateValue } = await import('../../src/runtime/interpreter.js');
  assert.equal(typeof keyToStateValue, 'function', 'keyToStateValue must be exported');
  assert.equal(keyToStateValue('idle'), 'idle');
  assert.deepEqual(keyToStateValue('flow.step1'), { flow: 'step1' });
  assert.deepEqual(keyToStateValue('a.b.c'), { a: { b: 'c' } });
});

// ── latencies circular buffer ──────────────────────────────────────────────────
test('getLatencies returns a new array each call (not same reference)', async () => {
  const { getLatencies } = await import('../../src/api/routes/actors.js');
  const a = getLatencies();
  const b = getLatencies();
  assert.notStrictEqual(a, b, 'getLatencies must return a new array each call, not the internal buffer');
});

test('latencies wraps correctly — length never exceeds 10000', async () => {
  const { getLatencies } = await import('../../src/api/routes/actors.js');
  const arr = getLatencies();
  assert.ok(Array.isArray(arr));
  assert.ok(arr.length <= 10000, `length must be <= 10000, got ${arr.length}`);
});

// ── writeBuffer.flushActor returns Promise ─────────────────────────────────────
test('flushActor returns a Promise for unknown actorId', async () => {
  process.env.STATEKEEP_DB_PATH        = ':memory:';
  process.env.STATEKEEP_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.NODE_ENV                 = 'test';

  const { getWriteBuffer } = await import('../../src/runtime/writeBuffer.js');
  const result = getWriteBuffer().flushActor('nonexistent-actor-xyz-foundation');
  assert.ok(result instanceof Promise, 'flushActor must return a Promise even for unknown actorIds');
  await result;
});
