#!/usr/bin/env node
/**
 * scripts/run-statechart-tests.mjs
 *
 * Cross-platform equivalent of run-statechart-tests.sh.
 * Runs the full statechart test suite (SC1–SC9 + SC9 HTTP) in order.
 *
 * Usage:
 *   node scripts/run-statechart-tests.mjs            — start server automatically
 *   SC_SKIP_SERVER=1 node scripts/run-statechart-tests.mjs  — server already running
 *
 * Exit codes:
 *   0 = all tests passed
 *   1 = one or more unexpected failures
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PORT    = '3099';
const LOG_DIR = join(tmpdir(), 'sc-test-logs');
const DB_PATH = join(tmpdir(), `sc-test-${Date.now()}.db`);

process.env.PORT                    = PORT;
process.env.NODE_ENV                = 'test';
process.env.STATEKEEP_DB_PATH       = process.env.STATEKEEP_DB_PATH ?? DB_PATH;
process.env.STATEKEEP_ENCRYPTION_KEY =
  process.env.STATEKEEP_ENCRYPTION_KEY ?? randomBytes(32).toString('hex');
process.env.LOG_DIR                 = LOG_DIR;
process.env.STATEKEEP_DATA_DIR      = join(tmpdir(), 'sc-test-data');

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(process.env.STATEKEEP_DATA_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('exit', code => resolve(code ?? 0));
    child.on('error', reject);
  });
}

async function waitForHealth(port, maxMs = 12000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Server did not become healthy on port ${port} within ${maxMs}ms`);
}

const SUITES = [
  ['SC1: Valid Statecharts',                   'test/statechart/sc1.valid.js'],
  ['SC2: Structural Breakage',                 'test/statechart/sc2.structural.js'],
  ['SC3: Logically Stuck Machines',            'test/statechart/sc3.stuck.js'],
  ['SC4: Migration Scenarios',                 'test/statechart/sc4.migration.js'],
  ['SC5: Complex Multi-Actor + Refinements',   'test/statechart/sc5.complex.js'],
  ['SC6: GC + Snapshot Worker Correctness',    'test/statechart/sc6.workers.js'],
  ['SC7: E2E Regression + Example Files',      'test/statechart/sc7.e2e.js'],
  ['SC8: Confirm-Token + needs_rescue Flow',   'test/statechart/sc8.confirmtoken.js'],
  ['SC9: Migration Routing (unit)',             'test/statechart/sc9.unit.js'],
  ['SC9: Migration Routing (HTTP)',             'test/statechart/sc9.migration-routing.js'],
];

// ── Main ──────────────────────────────────────────────────────────────────────

let serverProc = null;

async function main() {
  if (process.env.SC_SKIP_SERVER !== '1') {
    console.log('→ Starting API server...');
    serverProc = spawn(process.execPath, ['src/api/server.js'], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env },
    });
    serverProc.on('error', err => {
      console.error('Server process error:', err.message);
    });
    await waitForHealth(PORT);
    console.log(`✓ Server ready (PID ${serverProc.pid})`);
  }

  let pass = 0;
  let fail = 0;

  for (const [label, file] of SUITES) {
    console.log('');
    console.log('━'.repeat(65));
    console.log(`→ ${label}`);
    console.log('━'.repeat(65));
    const code = await run(process.execPath, ['--test', join(ROOT, file)], { cwd: ROOT });
    if (code === 0) {
      console.log(`✓ ${label} PASSED`);
      pass++;
    } else {
      console.log(`✗ ${label} FAILED`);
      fail++;
    }
  }

  if (serverProc) {
    serverProc.kill();
  }

  console.log('');
  console.log('═'.repeat(65));
  console.log(`  Passed: ${pass}  |  Failed: ${fail}`);
  console.log('═'.repeat(65));

  if (fail > 0) {
    console.log(`✗ Statechart tests FAILED (${fail})`);
    process.exit(1);
  }
  console.log('✓ All statechart tests PASSED');
  process.exit(0);
}

main().catch(err => {
  if (serverProc) serverProc.kill();
  console.error('Fatal:', err.message);
  process.exit(1);
});
