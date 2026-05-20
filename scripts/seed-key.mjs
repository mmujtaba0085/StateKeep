import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
const db = new Database(process.env.STATEKEEP_DB_PATH);
const key = process.env.STATEKEEP_API_KEY;
const hash = await bcrypt.hash(key, 10);
db.prepare("INSERT OR REPLACE INTO api_keys (key_hash, key_id, label, tier, created_at, org_id) VALUES (?, ?, ?, ?, ?, ?)").run(hash, 'default-key', 'Default', 'enterprise', Date.now(), 'default');
console.log('Seeded:', key);
db.close();
