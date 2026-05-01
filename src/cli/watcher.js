/**
 * src/cli/watcher.js
 * Watches *.machine.ts (and .js) files and pushes on change.
 */

import { watch } from 'fs';
import { readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { pushCommand } from './push.js';

const MACHINE_PATTERN = /\.machine\.(ts|mts|js|mjs|json)$/;
const DEBOUNCE_MS     = 300;

function findMachineFiles(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        results.push(...findMachineFiles(full));
      } else if (entry.isFile() && MACHINE_PATTERN.test(entry.name)) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

export function startWatcher(dir, opts) {
  const absDir = resolve(dir ?? '.');
  console.log(`[watcher] Watching ${absDir} for *.machine.{ts,js,json} changes...`);

  const timers = new Map();

  function onChange(filePath) {
    if (!MACHINE_PATTERN.test(filePath)) return;
    if (timers.has(filePath)) clearTimeout(timers.get(filePath));
    timers.set(filePath, setTimeout(async () => {
      timers.delete(filePath);
      console.log(`[watcher] Changed: ${filePath}`);
      try {
        await pushCommand([filePath], opts);
      } catch (err) {
        console.error(`[watcher] Push failed for ${filePath}: ${err.message}`);
      }
    }, DEBOUNCE_MS));
  }

  watch(absDir, { recursive: true }, (eventType, filename) => {
    if (filename && MACHINE_PATTERN.test(filename)) {
      onChange(join(absDir, filename));
    }
  });

  // Initial push of all existing machine files
  const initial = findMachineFiles(absDir);
  if (initial.length > 0) {
    console.log(`[watcher] Found ${initial.length} machine file(s) — pushing initial state...`);
    for (const f of initial) {
      pushCommand([f], { ...opts, 'dry-run': false }).catch(e =>
        console.error(`[watcher] Initial push failed for ${f}: ${e.message}`)
      );
    }
  }
}
