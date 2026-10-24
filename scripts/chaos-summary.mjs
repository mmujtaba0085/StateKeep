#!/usr/bin/env node
/**
 * scripts/chaos-summary.mjs — summarise workflow chaos runs (test/chaos/workflow/simulate.mjs
 * --out files) into one table and one compact JSON file.
 *
 *   node scripts/chaos-summary.mjs run1.json run2.json ... [--json benchmarks/chaos/summary.json]
 *
 * Violations counted: every per-actor violation plus every end-of-run violation.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const args = process.argv.slice(2);
const ji = args.indexOf('--json');
const jsonOut = ji >= 0 ? args.splice(ji, 2)[1] : null;
if (!args.length) { console.error('usage: chaos-summary.mjs run.json... [--json out.json]'); process.exit(2); }

const runs = args.map((file) => {
  const r = JSON.parse(readFileSync(file, 'utf8'));
  const actors = r.actors ?? [];
  return {
    run: basename(file, '.json'),
    backend: r.backend, intensity: r.intensity, seed: r.seed, minutes: r.minutes,
    workflows: (r.workflows ?? []).length,
    actors: actors.length,
    deployments: (r.versions ?? []).filter((v) => v.kind !== 'v1').length,
    deploymentKinds: (r.versions ?? []).filter((v) => v.kind !== 'v1')
      .reduce((m, v) => ({ ...m, [v.kind]: (m[v.kind] ?? 0) + 1 }), {}),
    migrations: actors.reduce((s, a) => s + (a.notes?.migrations ?? 0), 0),
    faults: r.counters,
    violations: actors.reduce((s, a) => s + (a.violations?.length ?? 0), 0) + (r.finalViolations?.length ?? 0),
  };
});
const sum = (k) => runs.reduce((s, r) => s + (r[k] ?? 0), 0);
const fsum = (k) => runs.reduce((s, r) => s + (r.faults?.[k] ?? 0), 0);
const totals = {
  runs: runs.length, actors: sum('actors'), workflows: sum('workflows'), deployments: sum('deployments'),
  migrations: sum('migrations'), violations: sum('violations'),
  serverKills: fsum('serverKills'), dbConnectionDrops: fsum('dbBlips'), serviceCrashes: fsum('serviceCrashes'),
  outages: fsum('outages'), workerKills: fsum('migrateWorkerKills') + fsum('schedulerKills'),
};

const row = (c) => `| ${c.join(' | ')} |`;
console.log(row(['Run', 'Backend', 'Intensity', 'Actors', 'Deployments', 'Migrations', 'Server kills', 'DB drops', 'Service crashes', 'Violations']));
console.log(row(Array(10).fill('---')));
for (const r of runs) {
  console.log(row([r.run, r.backend, r.intensity, r.actors, r.deployments, r.migrations,
    r.faults?.serverKills ?? 0, r.faults?.dbBlips ?? 0, r.faults?.serviceCrashes ?? 0, `**${r.violations}**`]));
}
console.log(row(['**Total**', '', '', totals.actors, totals.deployments, totals.migrations,
  totals.serverKills, totals.dbConnectionDrops, totals.serviceCrashes, `**${totals.violations}**`]));

if (jsonOut) {
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify({ generatedAt: new Date().toISOString(), totals, runs }, null, 2) + '\n');
}
process.exit(totals.violations === 0 ? 0 : 1);
