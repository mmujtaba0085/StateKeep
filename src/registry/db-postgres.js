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

const SCHEMA_VERSION = 1;

export async function bootstrapSchema() {
  const sql = readFileSync(join(__dirname, 'migrations', 'postgres', '001_initial.sql'), 'utf8');

  await transaction(async (client) => {
    // Ensure schema_migrations table exists first
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        applied_at BIGINT NOT NULL
      )
    `);

    const existing = await client.query(
      `SELECT version FROM schema_migrations WHERE version = $1`,
      [SCHEMA_VERSION]
    );
    if (existing.rows.length > 0) return; // already applied

    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [SCHEMA_VERSION, Date.now()]
    );
    console.log(`[db-postgres] Schema v${SCHEMA_VERSION} applied`);
  });
}
