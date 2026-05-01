/**
 * src/cli/dev.js
 * `statekeep dev` — starts the API server + file watcher in parallel.
 */

import { spawn } from 'child_process';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { startWatcher } from './watcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '../../');

export function devCommand(args, opts) {
  const watchDir = args[0] ?? opts.dir ?? '.';
  const port     = opts.port ?? process.env.PORT ?? '3000';

  console.log('[dev] Starting StateKeep development server...');

  // Start API server
  const server = spawn(process.execPath, [join(ROOT, 'src/api/server.js')], {
    env:   { ...process.env, PORT: String(port), NODE_ENV: 'development' },
    stdio: 'inherit',
  });

  server.on('error', err => {
    console.error('[dev] Server failed to start:', err.message);
    process.exit(1);
  });

  server.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[dev] Server exited with code ${code}`);
      process.exit(code ?? 1);
    }
  });

  // Give the server a moment to bind before printing the watcher banner
  setTimeout(() => {
    console.log(`[dev] Server running at http://localhost:${port}`);
    console.log(`[dev] Dashboard: http://localhost:${port}/dashboard/`);
  }, 800);

  // Start file watcher
  startWatcher(watchDir, { ...opts, url: `http://localhost:${port}` });

  // Forward signals
  process.on('SIGINT',  () => { server.kill('SIGINT');  process.exit(0); });
  process.on('SIGTERM', () => { server.kill('SIGTERM'); process.exit(0); });
}
