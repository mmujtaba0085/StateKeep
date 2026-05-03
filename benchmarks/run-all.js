/**
 * benchmarks/run-all.js
 *
 * Runs all 6 migration approaches sequentially against isolated orgs,
 * prints a comparison table with actor distribution, and writes a JSON report.
 *
 * Usage:
 *   node run-all.js               # all approaches
 *   node run-all.js --only 1      # single approach by number
 *   node run-all.js --only 1,3,5  # multiple approaches
 */

import { config }                              from './config.js';
import { Client }                              from './shared/client.js';
import { setupScenario, cleanup }              from './shared/setup.js';
import { printReport, writeReport, printDist } from './shared/report.js';

import * as A1  from './approaches/1-apv-engine.js';
import * as A2  from './approaches/2-full-table-update.js';
import * as A3  from './approaches/3-json-field-routing.js';
import * as A4  from './approaches/4-event-history-query.js';
import * as A5  from './approaches/5-xstate-resolvestate.js';
import * as A6  from './approaches/6-apv-chained.js';
import * as A7  from './approaches/7-context-mutation.js';
import * as A8  from './approaches/8-event-pollution.js';
import * as A9  from './approaches/9-missing-context.js';
import * as A10 from './approaches/10-chain-deep.js';
import * as A11 from './approaches/11-stress.js';
import * as A12 from './approaches/12-parallel-states.js';

const ALL_APPROACHES = [A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12];

function parseOnlyFlag() {
  const idx = process.argv.indexOf('--only');
  if (idx < 0) return null;
  const val = process.argv[idx + 1] ?? '';
  return val.split(',').map(n => parseInt(n.trim(), 10)).filter(n => n >= 1 && n <= 12);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const client     = new Client(config.baseUrl);
const onlyNums   = parseOnlyFlag();
const approaches = onlyNums
  ? ALL_APPROACHES.filter((_, i) => onlyNums.includes(i + 1))
  : ALL_APPROACHES;

const perGroup = Math.floor(config.actorCount / 3);

console.log('\n┌─────────────────────────────────────────────────────────┐');
console.log('│            StateKeep Migration Benchmark                │');
console.log('└─────────────────────────────────────────────────────────┘');
console.log(`  Server:      ${config.baseUrl}`);
console.log(`  Actors:      ${perGroup * 3} (${perGroup} per group × 3 groups)`);
console.log(`  Groups:      A (paid fee), B (waived fee), C (fast-tracked)`);
console.log(`  Scenario:    v1→v2 (A migrates, C strands), v3 rescue (C), v4 chain (A, Approach 6)`);
console.log(`  Approaches:  ${approaches.map(a => a.name).join(', ')}`);
if (!config.dbPath) {
  console.log('  Note:        STATEKEEP_DB_PATH not set — approaches 2–5 will be skipped');
}
console.log('');

const health = await client.get('/v1/health');
if (health.status !== 200) {
  console.error(`ERROR: Cannot reach StateKeep server at ${config.baseUrl}`);
  process.exit(1);
}
console.log(`  Engine:      ${health.body.engine ?? 'unknown'} (from /v1/health)`);
if (health.body.engine !== 'real') {
  console.log('  ⚠  APV engine in fallback mode — approaches 1 and 6 will not route by history\n');
}

const results = [];

for (const approach of approaches) {
  console.log(`\n──── ${approach.description} ${'─'.repeat(Math.max(0, 52 - approach.description.length))}`);

  process.stdout.write('  Setting up scenario...');
  let setup;
  try {
    setup = await setupScenario(client, config);
    console.log(` done — ${setup.allActorIds.length} actors: ${setup.groupA.length}A (paid) + ${setup.groupB.length}B (waived) + ${setup.groupC.length}C (fast-track)`);
  } catch (err) {
    console.error(`\n  SETUP FAILED: ${err.message}`);
    results.push({ approach: approach.name, description: approach.description, error: err.message, developerCode: approach.developerCode });
    continue;
  }

  process.stdout.write(`  Running ${approach.name}...`);
  let result;
  try {
    result = await approach.run(client, setup, config);
    if (result.skipped) {
      console.log(` skipped — ${result.skipReason}`);
    } else {
      const acc = result.routing?.accuracy ?? '?';
      const t   = result.totalMs ?? Math.round(result.phase1Ms ?? 0);
      const phases = [result.phase1Ms, result.phase2Ms, result.phase3Ms]
        .filter(Boolean).map(ms => `${Math.round(ms)}ms`).join('+');
      console.log(` done  ${t}ms (${phases})  accuracy=${acc}%  wrong=${result.routing?.wrong ?? '?'}`);
    }
  } catch (err) {
    console.error(`\n  RUN FAILED: ${err.message}`);
    result = { approach: approach.name, description: approach.description, error: err.message, developerCode: approach.developerCode };
  }

  results.push(result);

  // Print actor distribution
  if (result?.dist && !result.skipped) {
    printDist(result.dist);
  }

  process.stdout.write('  Cleaning up actors...');
  try {
    await cleanup(client, setup.apiKey, setup.allActorIds);
    console.log(' done');
  } catch {
    console.log(' (cleanup errors ignored)');
  }

  if (approaches.indexOf(approach) < approaches.length - 1) await sleep(500);
}

printReport(results, config);
writeReport(results, config);
