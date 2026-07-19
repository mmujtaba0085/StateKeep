import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../../../src/registry/db.js';

test('v19: running_invokes table exists', () => {
  const db = getDb();
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='running_invokes'`).get();
  assert.ok(row, 'running_invokes table should exist');
});

test('v20: action_jobs table exists', () => {
  const db = getDb();
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='action_jobs'`).get();
  assert.ok(row);
});

test('v21: migration_notifications table exists', () => {
  const db = getDb();
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='migration_notifications'`).get();
  assert.ok(row);
});

test('v22: actors.state_entry_id column exists', () => {
  const db = getDb();
  const col = db.prepare(`SELECT name FROM pragma_table_info('actors') WHERE name='state_entry_id'`).get();
  assert.ok(col, 'state_entry_id column should exist on actors');
});

test('v23: definitions.compiled_json column exists', () => {
  const db = getDb();
  const col = db.prepare(`SELECT name FROM pragma_table_info('definitions') WHERE name='compiled_json'`).get();
  assert.ok(col, 'compiled_json column should exist on definitions');
});
