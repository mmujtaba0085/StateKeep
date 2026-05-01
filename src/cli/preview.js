/**
 * src/cli/preview.js
 * `statekeep preview <file> --parent <parentId>`
 */

import { createClient } from './client.js';
import { extractDefinition } from './extractor.js';

export async function previewCommand(args, opts) {
  const [filePath] = args;
  if (!filePath) {
    console.error('Usage: statekeep preview <file> --parent <parentId>');
    process.exit(1);
  }

  const parentId = opts.parent ?? opts.parentId;
  if (!parentId) {
    console.error('[preview] --parent <parentId> is required');
    process.exit(1);
  }

  let definition;
  try {
    definition = await extractDefinition(filePath);
  } catch (err) {
    console.error(`[preview] Failed to load definition: ${err.message}`);
    process.exit(1);
  }

  const client = createClient({ baseUrl: opts.url, apiKey: opts.key });

  console.log(`[preview] Previewing migration from "${parentId}"...`);

  const res = await client.post('/v1/definitions/preview', { parentId, definition });

  if (res.ok) {
    const { migration, strandedActors, warnings, wouldDeploy } = res.body;

    if (warnings?.length) {
      console.warn('[preview] Warnings:');
      warnings.forEach(w => console.warn(`  - [${w.code}] ${w.message}`));
    }

    console.log(`\n[preview] Would deploy: ${wouldDeploy ? 'YES' : 'NO (stranded actors)'}`);

    if (strandedActors?.length) {
      console.log('\nStranded actors (would become needs_rescue):');
      strandedActors.forEach(s => console.log(`  state "${s.currentState}": ${s.count} actor(s)`));
    }

    if (migration) {
      console.log(`\nMigration routing (${migration.eligible} eligible actors):`);
      console.log(`  Would migrate: ${migration.wouldMigrate?.length ?? 0}`);
      console.log(`  Would stay:    ${migration.wouldStay?.length ?? 0}`);
      if (!migration.engineAvailable) {
        console.log('  (APV engine unavailable — routing estimates only)');
      }
    }
  } else {
    console.error(`[preview] Failed (HTTP ${res.status}):`);
    console.error(JSON.stringify(res.body, null, 2));
    process.exit(1);
  }
}
