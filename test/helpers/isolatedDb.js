/**
 * Tests that start their own server with special settings (remote implementations,
 * a Python service, …) must not share a Postgres database with other servers from
 * the same run: every server polls the shared action-job queue and would pick up —
 * and fail — jobs it has no implementation for.
 *
 * On Postgres: create a fresh database next to STATEKEEP_DB_URL and return its URL.
 * On SQLite: return null (the caller uses its own file).
 */
export async function isolatedPostgres(name) {
  const url = process.env.STATEKEEP_DB_URL ?? '';
  if (!url.startsWith('postgres')) return null;
  const { default: pg } = await import('pg');
  const u = new URL(url);
  const db = `${u.pathname.slice(1) || 'statekeep'}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
  } finally { await admin.end(); }
  u.pathname = `/${db}`;
  return u.toString();
}
