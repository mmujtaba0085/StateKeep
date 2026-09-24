/**
 * src/registry/db-postgres.js
 *
 * Async Postgres adapter for StateKeep.
 * Active when STATEKEEP_DB_URL starts with "postgres".
 *
 * Exports:
 *   getPool()                → pg.Pool singleton
 *   query(sql, params)       → Promise<pg.QueryResult>
 *   queryOne(sql, params)    → Promise<row | null>
 *   queryAll(sql, params)    → Promise<row[]>
 *   transaction(fn)          → Promise<T>  (fn receives a client)
 *
 * Crypto helpers (encrypt/decrypt) are re-exported from db.js so
 * callers need only import from one place.
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export { encrypt, decrypt } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { Pool } = pg;

// node-postgres returns BIGINT (int8) as a string by default. StateKeep keeps ticks,
// deployed_at and millisecond timestamps in BIGINT columns and compares them in JS;
// as strings, '9' > '10' is true. All such values are far below 2^53, so parse them
// as Numbers (matching what better-sqlite3 returns on the SQLite backend).
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

let _pool = null;

export function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.STATEKEEP_DB_URL,
      max:              parseInt(process.env.STATEKEEP_PG_POOL_SIZE ?? '20', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    _pool.on('error', (err) => console.error('[db-postgres] Pool error:', err.message));
  }
  return _pool;
}

export async function closePool() {
  if (_pool) { try { await _pool.end(); } catch {} _pool = null; }
}

export async function query(sql, params = []) {
  return getPool().query(sql, params);
}

export async function queryOne(sql, params = []) {
  const result = await getPool().query(sql, params);
  return result.rows[0] ?? null;
}

export async function queryAll(sql, params = []) {
  const result = await getPool().query(sql, params);
  return result.rows;
}

export async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Schema bootstrap ──────────────────────────────────────────────────────────

// Every NNN_*.sql file in migrations/postgres is applied once, in order, each in its
// own transaction. (Previously only 001 was ever applied, so the Postgres schema
// stayed at v1 while the SQLite schema moved on to v25.)
import { readdirSync } from 'fs';

export async function bootstrapSchema() {
  const dir   = join(__dirname, 'migrations', 'postgres');
  const files = readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();

  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )
  `);

  for (const file of files) {
    const version = parseInt(file.slice(0, 3), 10);
    await transaction(async (client) => {
      // Serialise concurrent bootstraps (API server + workers starting together)
      await client.query('SELECT pg_advisory_xact_lock(727274)');
      const existing = await client.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [version]);
      if (existing.rows.length > 0) return;
      await client.query(readFileSync(join(dir, file), 'utf8'));
      await client.query(
        `INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [version, Date.now()]
      );
      console.log(`[db-postgres] Schema v${version} applied (${file})`);
    });
  }
}
