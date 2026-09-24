/**
 * test/test_sdks.js — runs the Python and Go SDK test suites against a live server.
 * Skips a language whose toolchain is not installed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3089, BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'sk-sdk-'));
const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'test', HOST: '127.0.0.1',
  STATEKEEP_DB_PATH: join(dir, 's.db'), STATEKEEP_ENCRYPTION_KEY: 'bb'.repeat(32),
  LOG_DIR: join(dir, 'logs'), STATEKEEP_DATA_DIR: join(dir, 'data') };
delete env.STATEKEEP_API_KEY; delete env.STATEKEEP_DB_URL; delete env.STATEKEEP_REMOTE_URL;
let server;
const has = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;

before(async () => {
  server = spawn(process.execPath, ['src/api/server.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/v1/health`)).ok) break; } catch {} await new Promise((r) => { setTimeout(r, 250); }); }
});
after(() => { server?.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });

test('Python SDK', { skip: !has('python3', ['--version']) && 'python3 not installed' }, () => {
  const r = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], { cwd: 'sdks/python', env: { ...process.env, STATEKEEP_URL: BASE }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stderr, /skipped 'STATEKEEP_URL/);
});

test('Go SDK', { skip: !has('go', ['version']) && 'go not installed' }, () => {
  const r = spawnSync('go', ['test', '-count=1', '-v', './...'], { cwd: 'sdks/go', env: { ...process.env, STATEKEEP_URL: BASE }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /SKIP/);
});
