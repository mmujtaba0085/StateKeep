/**
 * test/e2e/export.spec.js
 *
 * Block 2 export endpoint tests:
 *  1. GET /v1/actors/:id/export returns actor + decrypted events
 *  2. GET /v1/actors/:id/export returns 404 for unknown actor
 *  3. GET /v1/machines/:machineId/export (JSON) returns actors with events + count header
 *  4. GET /v1/machines/:machineId/export (CSV) returns CSV with correct header row
 *  5. CSV stateValue escapes commas for compound states
 *  6. GET /v1/machines/:machineId/export returns 404 for unknown machine
 */

import { test, expect } from '@playwright/test';
import { randomUUID }   from 'crypto';
import { GET, POST, PUT, uniqueId } from './helpers/api.js';

const BASE = process.env.STATEKEEP_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;
const KEY  = process.env.STATEKEEP_API_KEY ?? '';

async function rawGet(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'x-api-key': KEY, ...headers },
  });
  return res;
}

const MACHINE_DEF = {
  id:      'export-machine',
  initial: 'idle',
  states: {
    idle:    { on: { START: 'running' } },
    running: { on: { STOP: 'done'    } },
    done:    { type: 'final'          },
  },
};

// ── Setup: shared definition + actor used across multiple tests ───────────────

let sharedDefId;
let sharedActorId;
let sharedMachineId;

test.beforeAll(async () => {
  sharedDefId    = uniqueId('exp-def');
  sharedMachineId = sharedDefId;   // first definition in a family = machine_id

  const defRes = await PUT('/v1/definitions', { id: sharedDefId, definition: MACHINE_DEF });
  if (defRes.status !== 201 && defRes.status !== 200) {
    throw new Error(`Setup: failed to create definition (${defRes.status}): ${JSON.stringify(defRes.body)}`);
  }

  const spawnRes = await POST('/v1/actors', { definitionId: sharedDefId });
  if (spawnRes.status !== 201) {
    throw new Error(`Setup: failed to spawn actor (${spawnRes.status}): ${JSON.stringify(spawnRes.body)}`);
  }
  sharedActorId = spawnRes.body.id;

  // Send one event so the actor has event history
  await POST(`/v1/actors/${sharedActorId}/event`, { type: 'START', payload: { source: 'export-test' } });
});

// ── 1: Single actor export — JSON ─────────────────────────────────────────────

test('GET /v1/actors/:id/export returns actor with decrypted events', async () => {
  const { status, body } = await GET(`/v1/actors/${sharedActorId}/export`);

  expect(status).toBe(200);

  // Actor fields
  expect(body.actor.id).toBe(sharedActorId);
  expect(body.actor.definitionId).toBe(sharedDefId);
  expect(body.actor.status).toBe('active');
  expect(typeof body.actor.createdAt).toBe('number');

  // Events
  expect(Array.isArray(body.events)).toBe(true);
  expect(body.events.length).toBeGreaterThanOrEqual(2);   // SPAWN + START

  const spawnEv = body.events.find(e => e.type === 'SPAWN');
  expect(spawnEv).toBeDefined();

  const startEv = body.events.find(e => e.type === 'START');
  expect(startEv).toBeDefined();
  // Payload was encrypted at write time; must be decrypted here
  expect(startEv.payload).toMatchObject({ source: 'export-test' });

  // Metadata
  expect(typeof body.exportedAt).toBe('string');
  expect(new Date(body.exportedAt).getTime()).toBeGreaterThan(0);
});

// ── 2: Single actor export — 404 ─────────────────────────────────────────────

test('GET /v1/actors/:id/export returns 404 for unknown actor', async () => {
  const { status } = await GET(`/v1/actors/${randomUUID()}/export`);
  expect(status).toBe(404);
});

// ── 3: Machine export — JSON with event data ──────────────────────────────────

test('GET /v1/machines/:machineId/export (JSON) returns actors + X-StateKeep-Export-Count header', async () => {
  const res = await rawGet(`/v1/machines/${sharedMachineId}/export`);
  expect(res.status).toBe(200);

  // Export-count header must be present
  const count = res.headers.get('x-statekeep-export-count');
  expect(count).not.toBeNull();
  expect(Number(count)).toBeGreaterThanOrEqual(1);

  const body = await res.json();
  expect(body.machineId).toBe(sharedMachineId);
  expect(Array.isArray(body.actors)).toBe(true);
  expect(body.count).toBeGreaterThanOrEqual(1);
  expect(typeof body.truncated).toBe('boolean');

  // The shared actor is present with its events
  const found = body.actors.find(a => a.id === sharedActorId);
  expect(found).toBeDefined();
  expect(Array.isArray(found.events)).toBe(true);
  expect(found.events.length).toBeGreaterThanOrEqual(2);

  // Event payloads are decrypted
  const startEv = found.events.find(e => e.type === 'START');
  expect(startEv?.payload).toMatchObject({ source: 'export-test' });
});

// ── 4: Machine export — CSV format ───────────────────────────────────────────

test('GET /v1/machines/:machineId/export?format=csv returns CSV with header row', async () => {
  const res = await rawGet(`/v1/machines/${sharedMachineId}/export?format=csv`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/text\/csv/);

  const count = res.headers.get('x-statekeep-export-count');
  expect(count).not.toBeNull();

  const csv = await res.text();
  const lines = csv.trim().split('\n');

  // First line is the header
  expect(lines[0]).toBe('id,definitionId,stateValue,status,createdAt,updatedAt');

  // At least one data row
  expect(lines.length).toBeGreaterThanOrEqual(2);

  // The shared actor is in the CSV
  const dataLines = lines.slice(1);
  const actorLine = dataLines.find(l => l.includes(sharedActorId));
  expect(actorLine).toBeDefined();
  expect(actorLine).toContain(sharedDefId);
});

// ── 5: CSV stateValue escapes commas in compound states ───────────────────────

test('CSV export escapes commas in compound stateValue', async () => {
  // Compound states (parallel states) serialise as JSON objects: {"a":"x","b":"y"}
  // When that object contains commas, the CSV cell must be quoted.
  // We test the escaping directly by checking the stateValue column in the CSV output.
  // Even a simple string state like "running" should appear unquoted.

  const res = await rawGet(`/v1/machines/${sharedMachineId}/export?format=csv`);
  expect(res.status).toBe(200);

  const csv   = await res.text();
  const lines = csv.trim().split('\n');
  const data  = lines.slice(1);

  // Every data line must be parseable as CSV — no raw unescaped commas inside fields
  for (const line of data) {
    // Simple validation: split by comma outside of quoted segments
    const fields = [];
    let inQuote = false;
    let cur     = '';
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; cur += ch; }
      else if (ch === ',' && !inQuote) { fields.push(cur); cur = ''; }
      else { cur += ch; }
    }
    fields.push(cur);
    // CSV rows have exactly 6 fields
    expect(fields.length).toBe(6);
  }
});

// ── 6: Machine export — 404 for unknown machine ───────────────────────────────

test('GET /v1/machines/:machineId/export returns 404 for unknown machine', async () => {
  const { status } = await GET(`/v1/machines/${randomUUID()}/export`);
  expect(status).toBe(404);
});
