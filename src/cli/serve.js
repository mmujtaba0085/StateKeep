/**
 * src/cli/serve.js — `statekeep serve`: run a complete StateKeep on this machine.
 *
 *   npx statekeep serve                      SQLite in ./statekeep-data, http://127.0.0.1:3000
 *   npx statekeep serve --port 4000 --data /var/lib/statekeep
 *   STATEKEEP_DB_URL=postgres://… npx statekeep serve
 *
 * Starts the API server and the background workers (migrations, timers, webhooks,
 * archival, snapshots, metrics) with the same environment, restarts a worker that
 * exits, and stops everything on Ctrl-C. Every STATEKEEP_* variable is honoured; the
 * options below only fill in defaults.
 *
 *   --port <n>     API port (default PORT or 3000)
 *   --host <addr>  bind address (default HOST or 127.0.0.1)
 *   --data <dir>   SQLite database, logs and data (default ./statekeep-data)
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKERS = ['migrate', 'scheduler', 'webhook', 'gc', 'snapshot', 'metrics'];
const RESTART_MS = 5000;

export function serveCommand(_args, opts) {
  const data = resolve(opts.data ?? process.env.STATEKEEP_DATA_DIR ?? 'statekeep-data');
  mkdirSync(join(data, 'logs'), { recursive: true });
  const port = String(opts.port ?? process.env.PORT ?? '3000');
  const env = {
    ...process.env,
    PORT: port,
    HOST: String(opts.host ?? process.env.HOST ?? '127.0.0.1'),
    STATEKEEP_DATA_DIR: data,
    LOG_DIR: process.env.LOG_DIR ?? join(data, 'logs'),
    STATEKEEP_DB_PATH: process.env.STATEKEEP_DB_PATH ?? join(data, 'statekeep.db'),
    STATEKEEP_INTERNAL_URL: process.env.STATEKEEP_INTERNAL_URL ?? `http://127.0.0.1:${port}`,
  };

  const backend = env.STATEKEEP_DB_URL?.startsWith('postgres') ? 'PostgreSQL' : `SQLite (${env.STATEKEEP_DB_PATH})`;
  console.log(`[statekeep] ${backend}, http://${env.HOST}:${port}  (dashboard: /dashboard/, API docs: /docs)`);
  if (!env.STATEKEEP_ENCRYPTION_KEY) {
    console.log('[statekeep] STATEKEEP_ENCRYPTION_KEY is not set: actor context is stored unencrypted.\n' +
      '            For anything beyond a local trial: export STATEKEEP_ENCRYPTION_KEY=$(openssl rand -hex 32)');
  }

  let stopping = false;
  const children = new Set();
  const run = (name, file, restart) => {
    const child = spawn(process.execPath, [join(ROOT, file)], { env, stdio: 'inherit' });
    children.add(child);
    child.on('exit', (code, signal) => {
      children.delete(child);
      if (stopping) return;
      if (!restart) {                         // the API server: its exit ends everything
        console.error(`[statekeep] server exited (${signal ?? code}); stopping`);
        stop(code ?? 1);
        return;
      }
      console.error(`[statekeep] ${name} exited (${signal ?? code}); restarting in ${RESTART_MS / 1000}s`);
      setTimeout(() => { if (!stopping) run(name, file, true); }, RESTART_MS).unref();
    });
  };

  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    for (const c of children) c.kill('SIGTERM');
    const t = setTimeout(() => { for (const c of children) c.kill('SIGKILL'); process.exit(code); }, 8000);
    t.unref();
    const check = setInterval(() => { if (children.size === 0) { clearInterval(check); process.exit(code); } }, 100);
  };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));

  run('server', 'src/api/server.js', false);
  // Workers after the server has created the schema.
  setTimeout(() => { if (!stopping) for (const w of WORKERS) run(`${w}-worker`, `src/workers/${w}-worker.js`, true); }, 1500);
}
