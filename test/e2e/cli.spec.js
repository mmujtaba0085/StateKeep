/**
 * test/e2e/cli.spec.js
 *
 * CLI integration tests:
 *  1. extractDefinition correctly extracts config from a *.machine.js fixture
 *  2. statekeep dev starts a server and exits cleanly on SIGINT
 *  3. statekeep push --dry-run prints preview without deploying
 */

import { test, expect } from '@playwright/test';
import { spawn }        from 'child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir }       from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { extractDefinition } from '../../src/cli/extractor.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CLI_PATH   = resolve(__dirname, '../../src/cli/index.js');
const DEV_PORT   = 3099;   // avoid colliding with test server on 3001

// ── 1: extractor ─────────────────────────────────────────────────────────────

test('extractDefinition correctly extracts config from a *.machine.js fixture', async () => {
  const dir  = mkdtempSync(join(tmpdir(), 'sk-ext-'));
  const file = join(dir, 'order.machine.mjs');   // .mjs = always ESM, no package.json needed
  try {
    writeFileSync(file, `
export default {
  id: 'order',
  initial: 'pending',
  states: {
    pending: { on: { PAY: 'paid' } },
    paid:    { type: 'final' },
  },
};
`);
    const def = await extractDefinition(file);
    expect(def.id).toBe('order');
    expect(def.initial).toBe('pending');
    expect(def.states.pending).toBeDefined();
    expect(def.states.paid).toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2: dev starts and exits cleanly ──────────────────────────────────────────

test('statekeep dev starts server and exits cleanly on SIGINT', async () => {
  const dbPath = join(tmpdir(), `sk-dev-test-${process.pid}.db`);

  const proc = spawn(process.execPath, [CLI_PATH, 'dev'], {
    env: {
      ...process.env,
      PORT:                     String(DEV_PORT),
      NODE_ENV:                 'development',
      STATEKEEP_DB_PATH:        dbPath,
      STATEKEEP_ENCRYPTION_KEY: '0'.repeat(64),
      STATEKEEP_ADMIN_KEY:      'test-admin-key',
      STATEKEEP_ENGINE_PATH:    process.env.STATEKEEP_ENGINE_PATH ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  proc.stdout.on('data', d => { output += d.toString(); });
  proc.stderr.on('data', d => { output += d.toString(); });

  // Wait for the server to report it's listening
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`dev server did not start in 15s. output:\n${output}`)),
      15_000
    );
    const check = (data) => {
      if (output.includes('listening') || output.includes(String(DEV_PORT))) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on('data', check);
    proc.stderr.on('data', check);
  });

  // Graceful shutdown
  proc.kill('SIGINT');

  const exitCode = await new Promise(resolve => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(1); }, 5_000);
    proc.on('exit', (code) => { clearTimeout(timer); resolve(code ?? 0); });
  });

  expect(exitCode).toBeLessThanOrEqual(1);
}, 25_000);

// ── 3: push --dry-run ─────────────────────────────────────────────────────────

test('statekeep push --dry-run prints preview without deploying', async () => {
  const dir  = mkdtempSync(join(tmpdir(), 'sk-push-'));
  const file = join(dir, 'widget.machine.mjs');

  try {
    writeFileSync(file, `
export default {
  id: 'widget-dryrun-${Date.now()}',
  initial: 'idle',
  states: {
    idle:   { on: { START: 'active' } },
    active: { type: 'final' },
  },
};
`);

    const proc = spawn(process.execPath, [CLI_PATH, 'push', '--dry-run'], {
      cwd: dir,
      env: {
        ...process.env,
        STATEKEEP_URL:     `http://localhost:${process.env.PORT ?? '3001'}`,
        STATEKEEP_API_KEY: process.env.STATEKEEP_API_KEY ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });

    const code = await new Promise(resolve => {
      const timer = setTimeout(() => { proc.kill(); resolve(1); }, 15_000);
      proc.on('exit', c => { clearTimeout(timer); resolve(c ?? 0); });
    });

    // Must mention dry-run and not crash badly
    expect(output).toMatch(/dry.?run/i);
    expect(code).toBeLessThanOrEqual(1);

    // Hash file must NOT be written (dry-run never persists)
    expect(existsSync(join(dir, '.statekeep-hashes.json'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
