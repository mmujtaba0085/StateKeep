/**
 * src/registry/orgRepo.js
 * SQLite CRUD for the `orgs` table.
 */

import { getDb } from './db.js';
import { randomUUID } from 'crypto';

export function createOrg({ name }) {
  const id = randomUUID();
  getDb().prepare(`INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)`)
         .run(id, name, Date.now());
  return { id, name };
}

export function findOrgById(id) {
  return getDb().prepare(`SELECT * FROM orgs WHERE id = ?`).get(id) ?? null;
}

export function listOrgs() {
  return getDb().prepare(`SELECT * FROM orgs ORDER BY created_at ASC`).all();
}

export function deleteOrg(id) {
  getDb().prepare(`DELETE FROM orgs WHERE id = ?`).run(id);
}
