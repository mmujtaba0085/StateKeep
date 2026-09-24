/**
 * statekeep import <file> [--format asl|scxml|bpmn] [--id <machine-id>] [--out <file>]
 *                         [--deploy <definition-id>] [--url <server>]
 *
 * Converts a Step Functions / SCXML / BPMN file into a StateKeep definition (offline),
 * prints it (or writes --out), reports warnings, and optionally deploys it.
 */
import { readFileSync, writeFileSync } from 'fs';
import { importDefinition, detectFormat } from '../importers/index.js';
import { createClient } from './client.js';

export async function importCommand(args, opts) {
  const file = args[0];
  if (!file) { console.error('Usage: statekeep import <file> [--format asl|scxml|bpmn] [--id id] [--out file] [--deploy defId]'); process.exit(1); }
  const source = readFileSync(file, 'utf8');
  const format = opts.format ?? detectFormat(source);
  const { definition, warnings } = importDefinition(format, source, { id: opts.id });

  for (const w of warnings) console.error(`⚠ ${w.type}${w.at ? ` (${w.at})` : ''}: ${w.message}`);
  const json = JSON.stringify(definition, null, 2);
  if (opts.out) { writeFileSync(opts.out, json + '\n'); console.error(`✓ ${format} → ${opts.out} (${Object.keys(definition.states).length} states)`); }
  else if (!opts.deploy) console.log(json);

  if (opts.deploy) {
    const client = createClient({ baseUrl: opts.url });
    const r = await client.put('/v1/definitions', { id: opts.deploy, definition });
    if (!r.ok) { console.error(`✗ deploy failed (${r.status}): ${JSON.stringify(r.body)}`); process.exit(1); }
    console.error(`✓ deployed as ${opts.deploy}`);
  }
}
