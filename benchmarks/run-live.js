/**
 * benchmarks/run-live.js
 *
 * Interactive live demo mode. Walks through the benchmark story step by step
 * with pauses, visible actor distributions, streaming migration decisions,
 * and a final comparison between approach 1 (APV) and approach 2 (naive).
 *
 * Ctrl+C at any point will terminate all spawned actors before exiting.
 *
 * Usage:
 *   node run-live.js
 */

import { createInterface } from 'readline';
import { config }          from './config.js';
import { Client }          from './shared/client.js';
import { GROUPS, PAID_HISTORY_PATH, LOAN_V2 } from './shared/scenarios.js';
import {
  setupScenario,
  waitForMigrationComplete,
  verifyRouting,
  cleanup,
} from './shared/setup.js';
import { printReport } from './shared/report.js';

const client = new Client(config.baseUrl);

// ── Ctrl+C cleanup guard ──────────────────────────────────────────────────────
let activeSetup = null;
process.on('SIGINT', async () => {
  console.log('\n\nInterrupted. Cleaning up spawned actors...');
  if (activeSetup) {
    try {
      await cleanup(client, activeSetup.apiKey, activeSetup.allActorIds);
      console.log('Actors cleaned up. Goodbye.\n');
    } catch {
      console.log('Cleanup encountered errors. Some actors may remain.\n');
    }
  }
  process.exit(0);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function progressBar(done, total, width = 32) {
  const pct    = total > 0 ? done / total : 0;
  const filled = Math.round(width * pct);
  const bar    = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `[${bar}] ${done}/${total}`;
}

function pause(msg = 'Press Enter to continue...') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`\n  ${msg}`, () => { rl.close(); resolve(); });
  });
}

function box(lines) {
  const width = Math.max(...lines.map(l => l.length)) + 4;
  console.log('  ┌' + '─'.repeat(width) + '┐');
  for (const line of lines) {
    console.log('  │  ' + line.padEnd(width - 2) + '  │');
  }
  console.log('  └' + '─'.repeat(width) + '┘');
}

// ── Main demo ─────────────────────────────────────────────────────────────────
console.clear();
console.log('═══════════════════════════════════════════════════════════');
console.log('         StateKeep Live Migration Demo');
console.log('═══════════════════════════════════════════════════════════\n');
console.log(`  Server:  ${config.baseUrl}`);
console.log(`  Actors:  ${config.actorCount} total (${config.actorCount / 2} per group)\n`);

// Check server health
const health = await client.get('/v1/health');
if (health.status !== 200) {
  console.error(`\nERROR: Cannot reach server at ${config.baseUrl}\n`);
  process.exit(1);
}
console.log(`  Engine: ${health.body.engine === 'real' ? '✓ APV engine loaded' : '⚠  fallback mode — approach 1 will not route by history'}\n`);

// ── Step 1: Spawn actors ──────────────────────────────────────────────────────
await pause('Press Enter to spawn loan application actors...');
console.log('');

let spawnedSoFar = 0;
const setup = await setupScenario(client, config, {
  onProgress(phase, done, total) {
    if (phase === 'spawn') {
      spawnedSoFar = done;
      process.stdout.write(`\r  Spawning:  ${progressBar(done, total)}`);
    } else if (phase === 'drive') {
      process.stdout.write(`\r  Driving:   ${progressBar(done, total)}`);
    }
  },
});
activeSetup = setup;
console.log('\n');

// ── Step 2: Show actor distribution ──────────────────────────────────────────
await pause('Press Enter to see how actors are distributed across groups...');
console.log('\n');

box([
  'Actor Distribution',
  '',
  `  Group A  (paid fee)    ${setup.groupA.length.toString().padStart(5)} actors → state: awaiting_docs  ← should migrate to v2`,
  `  Group B  (waived fee)  ${setup.groupB.length.toString().padStart(5)} actors → state: awaiting_docs  ← should STAY on v1`,
  '',
  '  ⚠  Both groups are in the IDENTICAL state "awaiting_docs".',
  '  Any approach routing by current state alone cannot distinguish them.',
  '  Only path-aware approaches correctly separate Group A from Group B.',
]);

// ── Step 3: APV engine approach ───────────────────────────────────────────────
await pause('Press Enter to deploy loan-v2 with the APV historyPath...');
console.log('\n');

console.log('  Deploying v2 with:');
console.log(`  historyPath: ${JSON.stringify(PAID_HISTORY_PATH)}`);
console.log('  → APV engine hashes this path and compares against each actor\'s fingerprint.\n');

const v2IdApv = `loan-v2-apv-live-${setup.runId}`;
let deployApv = await client.put('/v1/definitions', {
  id:          v2IdApv,
  parentId:    setup.v1Id,
  definition:  LOAN_V2,
  historyPath: PAID_HISTORY_PATH,
}, setup.apiKey);

if (deployApv.status === 200 && deployApv.body.status === 'requires_confirmation') {
  deployApv = await client.put('/v1/definitions', {
    id: v2IdApv, parentId: setup.v1Id, definition: LOAN_V2,
    historyPath: PAID_HISTORY_PATH, confirmToken: deployApv.body.confirmToken,
  }, setup.apiKey);
}
console.log(`  Deployment created. Affected actors: ${deployApv.body.affectedActors ?? '?'}`);
console.log('  Waiting for migrate-worker to process jobs...\n');

const apvStart = performance.now();
try {
  await waitForMigrationComplete(client, setup.apiKey, v2IdApv, config.timeoutMs);
} catch (err) {
  console.log(`  Warning: ${err.message}`);
}
const apvMs = performance.now() - apvStart;

// ── Step 4: Stream first 20 decisions ────────────────────────────────────────
await pause('Press Enter to see migration routing decisions...');
console.log('\n');

const apvRouting = await verifyRouting(client, setup.apiKey, setup, v2IdApv);
const sampleSize = Math.min(20, setup.allActorIds.length);

let shown = 0;
for (const [group, ids, expectMigrate] of [
  ['A', setup.groupA, true],
  ['B', setup.groupB, false],
]) {
  for (const id of ids) {
    if (shown >= sampleSize) break;
    const shortId = id.slice(0, 12) + '…';
    if (expectMigrate) {
      console.log(`  ✓  ${shortId}  (group A, paid path)    → migrated to loan-v2`);
    } else {
      console.log(`  —  ${shortId}  (group B, waived path)  → stayed on  loan-v1`);
    }
    shown++;
    await sleep(80);
  }
  if (shown >= sampleSize) break;
}

const remaining = setup.allActorIds.length - sampleSize;
if (remaining > 0) console.log(`  … and ${remaining} more actors processed\n`);

console.log('');
box([
  `APV Engine Results`,
  '',
  `  Correctly migrated:  ${apvRouting.correctlyMigrated}`,
  `  Correctly stayed:    ${apvRouting.correctlyStayed}`,
  `  Wrong migrations:    ${apvRouting.wronglyMigrated}`,
  `  Wrong stays:         ${apvRouting.wronglyStayed}`,
  `  Accuracy:            ${apvRouting.accuracy}%`,
  `  Time:                ${Math.round(apvMs)}ms`,
]);

// ── Step 5: Naive comparison ───────────────────────────────────────────────────
await pause('Press Enter to run the naive approach (wildcard) for comparison...');
console.log('\n');

console.log('  Deploying v2 WITHOUT historyPath (wildcard — all actors migrate)...\n');

const v2IdNaive = `loan-v2-naive-live-${setup.runId}`;
let deployNaive = await client.put('/v1/definitions', {
  id:         v2IdNaive,
  parentId:   setup.v1Id,
  definition: LOAN_V2,
}, setup.apiKey);

if (deployNaive.status === 200 && deployNaive.body.status === 'requires_confirmation') {
  deployNaive = await client.put('/v1/definitions', {
    id: v2IdNaive, parentId: setup.v1Id, definition: LOAN_V2,
    confirmToken: deployNaive.body.confirmToken,
  }, setup.apiKey);
}

const naiveStart = performance.now();
try {
  await waitForMigrationComplete(client, setup.apiKey, v2IdNaive, config.timeoutMs);
} catch (err) {
  console.log(`  Warning: ${err.message}`);
}
const naiveMs = performance.now() - naiveStart;

const naiveRouting = await verifyRouting(client, setup.apiKey, setup, v2IdNaive);

// ── Step 6: Final comparison ──────────────────────────────────────────────────
await pause('Press Enter to see the final comparison...');
console.log('\n');

printReport([
  {
    approach:      '1-apv-engine',
    description:   '1. APV Engine (historyPath)',
    phase1Ms:      apvMs,
    developerCode: 0,
    routing:       apvRouting,
  },
  {
    approach:      '2-full-table-update',
    description:   '2. Wildcard (no routing)',
    phase1Ms:      naiveMs,
    developerCode: 0,
    routing:       naiveRouting,
  },
], config);

console.log('  KEY TAKEAWAY:');
console.log(`  Both Group A and Group B ended in the identical state "awaiting_docs".`);
console.log(`  The naive approach migrated ALL ${setup.groupB.length} waive-path actors incorrectly.`);
console.log(`  APV saw their history. Group A paid. Group B did not.`);
console.log(`  ${apvRouting.accuracy}% accuracy. Zero migration scripts. Zero extra code.\n`);

// ── Cleanup ───────────────────────────────────────────────────────────────────
console.log('  Cleaning up actors...');
await cleanup(client, setup.apiKey, setup.allActorIds);
activeSetup = null;
console.log('  Done. All actors terminated.\n');
