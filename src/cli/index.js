#!/usr/bin/env node
/**
 * statekeep CLI
 *
 * Usage:
 *   statekeep push <file>          Push a machine definition to the server
 *   statekeep preview <file>       Preview migration impact (dry-run)
 *   statekeep dev [dir]            Start dev server + file watcher
 *
 * Common options:
 *   --url <url>                    StateKeep server URL (default: http://localhost:3000)
 *   --key <apiKey>                 API key (or set STATEKEEP_API_KEY env var)
 *
 * Push/preview options:
 *   --id <id>                      Definition ID (defaults to filename)
 *   --parent <parentId>            Parent definition ID (for versioning)
 *   --dry-run                      Validate without deploying (push only)
 */

import { pushCommand }    from './push.js';
import { previewCommand } from './preview.js';
import { devCommand }     from './dev.js';

const argv = process.argv.slice(2);

function parseArgs(rawArgs) {
  const args = [];
  const opts = {};
  let i = 0;
  while (i < rawArgs.length) {
    const a = rawArgs[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rawArgs[i + 1];
      if (next && !next.startsWith('--')) {
        opts[key] = next;
        i += 2;
      } else {
        opts[key] = true;
        i += 1;
      }
    } else {
      args.push(a);
      i += 1;
    }
  }
  return { args, opts };
}

const [command, ...rest] = argv;
const { args, opts } = parseArgs(rest);

switch (command) {
  case 'push':
    await pushCommand(args, opts);
    break;
  case 'preview':
    await previewCommand(args, opts);
    break;
  case 'dev':
    devCommand(args, opts);
    break;
  case '--help':
  case '-h':
  case 'help':
  case undefined:
    console.log(`
statekeep CLI

Commands:
  push <file>      Push a machine definition to the StateKeep server
  preview <file>   Preview migration impact without deploying
  dev [dir]        Start dev server + auto-push file watcher

Options:
  --url <url>      Server URL (default: http://localhost:3000)
  --key <apiKey>   API key (or STATEKEEP_API_KEY env var)
  --id <id>        Definition ID (push/preview, defaults to filename)
  --parent <id>    Parent definition ID (versioning)
  --dry-run        Validate only, no write (push)
  --port <port>    Port for dev server (default: 3000)

Examples:
  statekeep push order.machine.ts --id order-v2 --parent order-v1
  statekeep preview checkout.machine.ts --parent checkout-v1
  statekeep dev src/machines
`);
    break;
  default:
    console.error(`Unknown command: ${command}. Run statekeep --help for usage.`);
    process.exit(1);
}
