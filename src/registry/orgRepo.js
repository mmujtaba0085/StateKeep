/**
 * src/registry/orgRepo.js
 * CRUD for the `orgs` table.
 */

import { getDb, isPostgres } from './db.js';
import { randomUUID } from 'crypto';

export async function createOrg({ name }) {
  const id  = randomUUID();
  const now = Date.now();
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`INSERT INTO orgs (id, name, created_at) VALUES ($1,$2,$3)`, [id, name, now]);
  } else {
    getDb().prepare(`INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)`).run(id, name, now);
  }
  return { id, name };
}

export async function findOrgById(id) {
  if (isPostgres) {
    const { queryOne } = await import('./db-postgres.js');
    return await queryOne(`SELECT * FROM orgs WHERE id=$1`, [id]);
  }
  return getDb().prepare(`SELECT * FROM orgs WHERE id = ?`).get(id) ?? null;
}

export async function listOrgs() {
  if (isPostgres) {
    const { queryAll } = await import('./db-postgres.js');
    return await queryAll(`SELECT * FROM orgs ORDER BY created_at ASC`, []);
  }
  return getDb().prepare(`SELECT * FROM orgs ORDER BY created_at ASC`).all();
}

export async function deleteOrg(id) {
  if (isPostgres) {
    const { query } = await import('./db-postgres.js');
    await query(`DELETE FROM orgs WHERE id=$1`, [id]);
  } else {
    getDb().prepare(`DELETE FROM orgs WHERE id = ?`).run(id);
  }
}
