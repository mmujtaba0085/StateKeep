/**
 * test/statechart/sc12.context-transform.js
 *
 * Pure unit tests for applyContextTransform, getNestedValue, setNestedValue.
 * No server, no DB required.
 *
 * Run: node --test test/statechart/sc12.context-transform.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyContextTransform,
  getNestedValue,
  setNestedValue,
} from '../../src/runtime/actorWorker.js';

test('getNestedValue: flat key', () => {
  assert.equal(getNestedValue({ a: 1 }, 'a'), 1);
});

test('getNestedValue: nested dot path', () => {
  assert.equal(getNestedValue({ a: { b: { c: 42 } } }, 'a.b.c'), 42);
});

test('getNestedValue: missing path returns undefined', () => {
  assert.equal(getNestedValue({ a: 1 }, 'x.y'), undefined);
});

test('getNestedValue: null obj returns undefined', () => {
  assert.equal(getNestedValue(null, 'a'), undefined);
});

test('setNestedValue: flat key', () => {
  const obj = {};
  setNestedValue(obj, 'x', 5);
  assert.equal(obj.x, 5);
});

test('setNestedValue: creates intermediate objects', () => {
  const obj = {};
  setNestedValue(obj, 'a.b.c', 99);
  assert.equal(obj.a.b.c, 99);
});

test('applyContextTransform: flat field mapping', () => {
  const result = applyContextTransform(
    { feePaid: true, amount: 500 },
    { 'payment.verified': 'feePaid' }
  );
  assert.equal(result.payment.verified, true);
  // Additive — old field preserved
  assert.equal(result.feePaid, true);
  assert.equal(result.amount, 500);
});

test('applyContextTransform: absent old path is silently skipped', () => {
  const result = applyContextTransform(
    { a: 1 },
    { 'new.field': 'does.not.exist' }
  );
  assert.equal(result['new'], undefined);
  assert.equal(result.a, 1);
});

test('applyContextTransform: no transform returns original reference', () => {
  const ctx    = { x: 1 };
  const result = applyContextTransform(ctx, {});
  assert.equal(result, ctx);  // same reference
});

test('applyContextTransform: null transform returns original reference', () => {
  const ctx    = { x: 1 };
  const result = applyContextTransform(ctx, null);
  assert.equal(result, ctx);
});

test('applyContextTransform: does not mutate input', () => {
  const ctx  = { feePaid: true };
  const copy = JSON.parse(JSON.stringify(ctx));
  applyContextTransform(ctx, { 'payment.verified': 'feePaid' });
  assert.deepEqual(ctx, copy);
});

test('applyContextTransform: three-level nesting', () => {
  const result = applyContextTransform(
    { x: 42 },
    { 'a.b.c': 'x' }
  );
  assert.equal(result.a.b.c, 42);
  assert.equal(result.x, 42);
});

test('applyContextTransform: multiple mappings applied together', () => {
  const result = applyContextTransform(
    { feePaid: true, amount: 500, userId: 'u1' },
    { 'payment.verified': 'feePaid', 'payment.amount': 'amount' }
  );
  assert.equal(result.payment.verified, true);
  assert.equal(result.payment.amount, 500);
  assert.equal(result.feePaid, true);
  assert.equal(result.amount, 500);
  assert.equal(result.userId, 'u1');
});
