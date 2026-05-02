/**
 * test/setup.js
 *
 * Shared test utilities: in-memory SQLite DB, mock engine config, HTTP client.
 * Imported by all test files.
 *
 * Usage:
 *   STATEKEEP_ENGINE_PATH=./mock/libapv-mock.so node --test test/*.js
 *   (or unset STATEKEEP_ENGINE_PATH to test fallback mode)
 */

import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Test database in temp dir ─────────────────────────────────────────────────
const TEST_DIR = join(tmpdir(), `statekeep-test-${Date.now()}`);
mkdirSync(TEST_DIR, { recursive: true });
// Only override if not already set by parent process (e.g. run-all-tests.sh)
// so that tests sharing a server also share its database file.
if (!process.env.STATEKEEP_DB_PATH)        process.env.STATEKEEP_DB_PATH        = join(TEST_DIR, 'test.db');
if (!process.env.STATEKEEP_ENCRYPTION_KEY) process.env.STATEKEEP_ENCRYPTION_KEY = 'a'.repeat(64);
if (!process.env.STATEKEEP_ADMIN_KEY)      process.env.STATEKEEP_ADMIN_KEY      = 'test-admin-key';
process.env.LOG_DIR                  = TEST_DIR;
process.env.STATEKEEP_DATA_DIR       = TEST_DIR;
process.env.NODE_ENV                 = 'test';
process.env.PORT                     = '3099';

// Engine path defaults to mock if set in env; otherwise fallback mode
if (!process.env.STATEKEEP_ENGINE_PATH) {
  console.log('[test/setup] No STATEKEEP_ENGINE_PATH — running in fallback mode');
}

// ── HTTP client ───────────────────────────────────────────────────────────────

export const BASE_URL = 'http://127.0.0.1:3099';
export const TEST_KEY = '__test_key_do_not_use_in_production__';

export async function request(method, path, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'X-API-Key':     TEST_KEY,
      ...headers,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });

  const ct = res.headers.get('content-type') ?? '';
  const responseBody = ct.includes('application/json')
    ? await res.json()
    : await res.text();

  return { status: res.status, body: responseBody };
}

export const get    = (path, h) => request('GET',    path, null, h);
export const post   = (path, b, h) => request('POST',   path, b, h);
export const put    = (path, b, h) => request('PUT',    path, b, h);
export const del    = (path, h) => request('DELETE', path, null, h);

// ── Sample machine definition ─────────────────────────────────────────────────

export const SAMPLE_MACHINE_V1 = {
  id:      'idle',
  initial: 'idle',
  states: {
    idle:       { on: { START:  'running' } },
    running:    { on: { PAUSE:  'paused', STOP: 'done' } },
    paused:     { on: { RESUME: 'running', STOP: 'done' } },
    done:       { type: 'final' },
  },
};

export const SAMPLE_MACHINE_V2 = {
  id:      'idle',
  initial: 'idle',
  states: {
    idle:       { on: { START:  'running', INIT: 'initializing' } },
    initializing: { on: { READY: 'running' } },
    running:    { on: { PAUSE:  'paused', STOP: 'done' } },
    paused:     { on: { RESUME: 'running', STOP: 'done' } },
    done:       { type: 'final' },
  },
};

// ── Seed API key into DB ──────────────────────────────────────────────────────

export async function seedApiKey() {
  const { getDb } = await import('../src/registry/db.js');
  const { default: bcrypt } = await import('bcryptjs');
  const db   = getDb();
  const hash = await bcrypt.hash(TEST_KEY, 1);   // rounds=1 for speed in tests
  db.prepare(`INSERT OR REPLACE INTO api_keys (key_hash, label, tier, org_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(hash, 'test', 'enterprise', 'default', Date.now());
}
