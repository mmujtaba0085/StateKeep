/**
 * test/test_confirm_consent.js — deployments that strand actors need exact consent.
 *
 *   - the confirming request re-predicts the stranding under the deploy lock, right before
 *     the commit; an actor that was not in the preview turns it into a fresh preview;
 *   - fewer stranded actors than previewed is fine;
 *   - tokens are one-time, bound to the definition's content, and survive a restart;
 *   - every stranding emits actor.needs_rescue with consented: true|false.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedPostgres } from './helpers/isolatedDb.js';

const PORT = 3127, BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'sk-consent-'));
let server, pg;
const env = {
  ...process.env, PORT: String(PORT), NODE_ENV: 'test', HOST: '127.0.0.1',
  STATEKEEP_DB_PATH: join(dir, 'a.db'), STATEKEEP_ENCRYPTION_KEY: '7c'.repeat(32),
  STATEKEEP_ADMIN_KEY: 'consent-admin-key-123456', LOG_DIR: join(dir, 'logs'), STATEKEEP_DATA_DIR: join(dir, 'data'),
};
delete env.STATEKEEP_API_KEY;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const j = async (method, path, body) => {
  const headers = { 'x-admin-key': env.STATEKEEP_ADMIN_KEY, ...(body ? { 'content-type': 'application/json' } : {}) };
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
async function startServer() {
  server = spawn(process.execPath, ['src/api/server.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/v1/health`)).ok) return; } catch {} await sleep(150); }
  throw new Error('server did not start');
}
async function stopServer() {
  if (!server) return;
  const exited = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await Promise.race([exited, sleep(5000)]);
  server.kill('SIGKILL');
  server = null;
}
const put = (body) => j('PUT', '/v1/definitions', body);
const spawnActor = async (defId) => (await j('POST', '/v1/actors', { definitionId: defId })).body.id;
const send = (id, type) => j('POST', `/v1/actors/${id}/event`, { type });
const actorOf = async (id) => (await j('GET', `/v1/actors/${id}`)).body;

async function rawDb() {
  if (pg) {
    const { default: PG } = await import('pg');
    const c = new PG.Client({ connectionString: pg });
    await c.connect();
    const num = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
    return { all: async (sql, ps = []) => (await c.query(num(sql), ps)).rows,
             run: async (sql, ps = []) => { await c.query(num(sql), ps); }, close: () => c.end() };
  }
  const { default: Database } = await import('better-sqlite3');
  const d = new Database(env.STATEKEEP_DB_PATH);
  return { all: async (sql, ps = []) => d.prepare(sql).all(...ps),
           run: async (sql, ps = []) => { d.prepare(sql).run(...ps); }, close: async () => d.close() };
}

/** The actor.needs_rescue payloads queued so far, by actor id. */
async function rescueEvents() {
  const db = await rawDb();
  try {
    const rows = await db.all(`SELECT payload FROM webhook_deliveries WHERE event_type = 'actor.needs_rescue'`);
    return new Map(rows.map((r) => { const d = JSON.parse(r.payload).data; return [d.actorId, d]; }));
  } finally { await db.close(); }
}

before(async () => {
  pg = await isolatedPostgres('confirm_consent');
  if (pg) env.STATEKEEP_DB_URL = pg;
  await startServer();
  // A subscriber for actor.needs_rescue (delivery itself fails; the queued rows are what we read).
  const db = await rawDb();
  try {
    await db.run(`INSERT INTO webhooks (id, url, secret, events, active, created_at) VALUES (?, ?, ?, ?, ${pg ? 'true' : '1'}, ?)`,
      ['wh-consent', 'http://127.0.0.1:9/hook', Buffer.from('s'), JSON.stringify(['actor.needs_rescue']), Date.now()]);
  } finally { await db.close(); }
});
after(async () => { await stopServer(); rmSync(dir, { recursive: true, force: true }); });

// a --X--> b --Z--> a ; a --Y--> c.  The new version drops b.
const v1 = (fam) => ({ id: fam, initial: 'a', states: {
  a: { on: { X: 'b', Y: 'c' } }, b: { on: { Z: 'a' } }, c: { on: { Y: 'a' } } } });
const v2 = (fam, extra = {}) => ({ id: fam, initial: 'a', states: {
  a: { on: { X: 'c', Y: 'c' } }, c: { on: { Y: 'a' } }, ...extra } });

test('an actor that was not in the preview turns the confirmation into a fresh preview', async () => {
  assert.equal((await put({ id: 'cs1-v1', definition: v1('cs1') })).status, 201);
  const inB = await spawnActor('cs1-v1'); await send(inB, 'X');
  const late = await spawnActor('cs1-v1');

  const p1 = await put({ id: 'cs1-v2', parentId: 'cs1-v1', definition: v2('cs1') });
  assert.equal(p1.body.status, 'requires_confirmation');
  assert.equal(p1.body.strandedActors.reduce((s, g) => s + g.count, 0), 1);

  await send(late, 'X');   // now in b too: it would be stranded, but nobody consented

  const p2 = await put({ id: 'cs1-v2', parentId: 'cs1-v1', definition: v2('cs1'), confirmToken: p1.body.confirmToken });
  assert.equal(p2.status, 200, 'nothing deployed');
  assert.equal(p2.body.status, 'requires_confirmation');
  assert.equal(p2.body.notInPreview, 1);
  assert.equal(p2.body.strandedActors.reduce((s, g) => s + g.count, 0), 2);
  assert.notEqual(p2.body.confirmToken, p1.body.confirmToken);
  assert.equal((await j('GET', '/v1/definitions/cs1-v2')).status, 404);

  const ok = await put({ id: 'cs1-v2', parentId: 'cs1-v1', definition: v2('cs1'), confirmToken: p2.body.confirmToken });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  for (const id of [inB, late]) assert.equal((await actorOf(id)).status, 'needs_rescue');
  await sleep(300);
  const ev = await rescueEvents();
  assert.equal(ev.get(inB)?.consented, true);
  assert.equal(ev.get(late)?.consented, true);
});

test('fewer stranded actors than previewed is fine', async () => {
  assert.equal((await put({ id: 'cs2-v1', definition: v1('cs2') })).status, 201);
  const stays = await spawnActor('cs2-v1'); await send(stays, 'X');
  const leaves = await spawnActor('cs2-v1'); await send(leaves, 'X');
  const p1 = await put({ id: 'cs2-v2', parentId: 'cs2-v1', definition: v2('cs2') });
  assert.equal(p1.body.strandedActors.reduce((s, g) => s + g.count, 0), 2);

  await send(leaves, 'Z');   // back to a: placeable now
  const ok = await put({ id: 'cs2-v2', parentId: 'cs2-v1', definition: v2('cs2'), confirmToken: p1.body.confirmToken });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await actorOf(stays)).status, 'needs_rescue');
  assert.equal((await send(leaves, 'X')).status < 300, true);   // routed before its next event
  const moved = await actorOf(leaves);
  assert.equal(moved.status, 'active');
  assert.equal(moved.definitionId, 'cs2-v2');
});

test('tokens are one-time, bound to the content, and survive a restart', async () => {
  assert.equal((await put({ id: 'cs3-v1', definition: v1('cs3') })).status, 201);
  const a = await spawnActor('cs3-v1'); await send(a, 'X');

  // bound to the content: a different definition under the same id gets a fresh preview
  const p1 = await put({ id: 'cs3-v2', parentId: 'cs3-v1', definition: v2('cs3') });
  const changed = await put({ id: 'cs3-v2', parentId: 'cs3-v1', definition: v2('cs3', { d: {} }), confirmToken: p1.body.confirmToken });
  assert.equal(changed.status, 200);
  assert.match(changed.body.reason, /definition changed/);

  // one-time: p1's token was consumed by the attempt above
  const reused = await put({ id: 'cs3-v2', parentId: 'cs3-v1', definition: v2('cs3'), confirmToken: p1.body.confirmToken });
  assert.equal(reused.status, 200);
  assert.match(reused.body.reason, /not found|already used/);

  // survives a restart
  await stopServer(); await startServer();
  const ok = await put({ id: 'cs3-v2', parentId: 'cs3-v1', definition: v2('cs3'), confirmToken: reused.body.confirmToken });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await actorOf(a)).status, 'needs_rescue');
});

test('a stranding nobody saw in a preview is reported with consented: false', async () => {
  // historyPath [X]: an actor still in a is not routed at deploy time (no preview lists
  // it); once its history is [X] it is in b, which this version cannot place.
  assert.equal((await put({ id: 'cs4-v1', definition: v1('cs4') })).status, 201);
  const a = await spawnActor('cs4-v1');
  const d = await put({ id: 'cs4-v2', parentId: 'cs4-v1', historyPath: ['X'], definition: v2('cs4') });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.ok((d.body.warnings ?? []).some((w) => w.code === 'LATE_MATCHER_RISK'));
  await send(a, 'X');
  await send(a, 'Z');      // routed before this event: stranded
  assert.equal((await actorOf(a)).status, 'needs_rescue');
  await sleep(300);
  assert.equal((await rescueEvents()).get(a)?.consented, false);
});
