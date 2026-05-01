/**
 * src/cli/push.js
 * `statekeep push [--dry-run] [--parent <id>]`
 *
 * Globs **.machine.{ts,js} from cwd, hashes each file against
 * .statekeep-hashes.json, shows a migration preview for changed files,
 * and prompts [y/n/skip] before each deploy.
 *
 * --dry-run  Print preview only; skip prompt and deploy.
 */

import { createHash } from 'crypto';
import { createInterface } from 'readline';
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve, relative } from 'path';
import { createClient } from './client.js';
import { extractDefinition } from './extractor.js';

const HASH_FILE    = '.statekeep-hashes.json';
const MACHINE_PAT  = /\.machine\.(ts|mts|js|mjs)$/;
const SKIP_DIRS    = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

// ── File discovery ─────────────────────────────────────────────────────────────

function findMachineFiles(root = '.') {
  const results = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (MACHINE_PAT.test(entry.name)) {
        results.push(full);
      }
    }
  }
  try { walk(resolve(root)); } catch {}
  return results;
}

function hashFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function loadHashes() {
  try { return JSON.parse(readFileSync(HASH_FILE, 'utf8')); } catch { return {}; }
}

function saveHashes(hashes) {
  writeFileSync(HASH_FILE, JSON.stringify(hashes, null, 2) + '\n');
}

// ── Prompt ─────────────────────────────────────────────────────────────────────

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase()); });
  });
}

// ── Preview printing ───────────────────────────────────────────────────────────

function printPreview(body) {
  const { migration, strandedActors, warnings, wouldDeploy } = body;
  console.log(`  Would deploy : ${wouldDeploy ? 'YES' : 'NO (stranded actors block)'}`);
  if (warnings?.length) {
    for (const w of warnings) console.log(`  ⚠  [${w.code}] ${w.message}`);
  }
  if (strandedActors?.length) {
    console.log('  Stranded actors:');
    for (const s of strandedActors) console.log(`    state "${s.currentState}": ${s.count} actor(s)`);
  }
  if (migration) {
    console.log(`  Eligible: ${migration.eligible} | migrate: ${migration.wouldMigrate?.length ?? 0} | stay: ${migration.wouldStay?.length ?? 0}`);
    if (!migration.engineAvailable) console.log('  (APV engine unavailable — estimates only)');
  }
}

// ── Main command ───────────────────────────────────────────────────────────────

export async function pushCommand(args, opts) {
  const dryRun   = !!(opts['dry-run'] ?? opts.dryRun);
  const parentId = opts.parent ?? opts.parentId ?? undefined;
  const client   = createClient({ baseUrl: opts.url, apiKey: opts.key });

  const files = findMachineFiles('.');
  if (files.length === 0) {
    console.log('[push] No *.machine.{ts,js} files found in current directory.');
    return;
  }

  const hashes    = loadHashes();
  const newHashes = { ...hashes };
  const changed   = files.filter(f => hashFile(f) !== hashes[relative('.', f)]);

  if (changed.length === 0) {
    console.log('[push] No changed machine files. Nothing to do.');
    return;
  }

  console.log(`[push] ${changed.length} changed file(s)${dryRun ? ' [dry-run]' : ''}:`);

  for (const filePath of changed) {
    const rel = relative('.', filePath);
    console.log(`\n→ ${rel}`);

    let definition;
    try {
      definition = await extractDefinition(filePath);
    } catch (err) {
      console.error(`  extract failed: ${err.message}`);
      continue;
    }

    const id = opts.id ?? definition.id
      ?? rel.replace(/\.machine\.(ts|mts|js|mjs)$/, '').replace(/[^a-z0-9-_]/gi, '-');

    // Preview
    const prevRes = await client.post('/v1/definitions/preview', { parentId, definition });
    if (prevRes.ok) {
      printPreview(prevRes.body);
    } else {
      console.log(`  (preview unavailable: HTTP ${prevRes.status})`);
    }

    if (dryRun) {
      console.log('  [dry-run] skipping deploy');
      continue;
    }

    const answer = await ask('  Deploy? [y/n/skip] ');
    if (answer !== 'y' && answer !== 'yes') {
      console.log('  Skipped.');
      continue;
    }

    const deployRes = await client.put('/v1/definitions', { id, parentId, definition });
    if (deployRes.ok || deployRes.status === 201) {
      console.log(`  ✓ Deployed "${id}" (HTTP ${deployRes.status})`);
      newHashes[rel] = hashFile(filePath);
    } else {
      console.error(`  ✗ Failed HTTP ${deployRes.status}: ${JSON.stringify(deployRes.body)}`);
    }
  }

  if (!dryRun) {
    saveHashes(newHashes);
  }
}
