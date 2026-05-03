/**
 * benchmarks/config.js
 *
 * Loads .env from the benchmarks/ directory and exports a validated config object.
 * All benchmark files import from here — never from process.env directly.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname }         from 'path';
import { fileURLToPath }            from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Simple .env loader — no external dep required
const envPath = resolve(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}

export const config = {
  baseUrl:       process.env.STATEKEEP_URL           ?? 'http://localhost:3001',
  adminKey:      process.env.STATEKEEP_ADMIN_KEY      ?? '',
  apiKey:        process.env.STATEKEEP_API_KEY        ?? '',
  actorCount:    Math.max(4, parseInt(process.env.ACTOR_COUNT ?? '1000', 10)),
  dbPath:        process.env.STATEKEEP_DB_PATH        ?? '',
  encryptionKey: process.env.STATEKEEP_ENCRYPTION_KEY ?? '',
  timeoutMs:     parseInt(process.env.MIGRATION_TIMEOUT_MS ?? '120000', 10),
  batchSize:     50,
};

// Ensure actorCount is divisible by 3 (one third per group A/B/C)
config.actorCount = Math.floor(config.actorCount / 3) * 3;

if (!config.adminKey) {
  console.error('\nERROR: STATEKEEP_ADMIN_KEY is required.');
  console.error('Copy .env.example to .env and fill in your server credentials.\n');
  process.exit(1);
}

if (!config.apiKey) {
  console.error('\nERROR: STATEKEEP_API_KEY is required.');
  console.error('This must be a valid API key for your running StateKeep server.\n');
  process.exit(1);
}
