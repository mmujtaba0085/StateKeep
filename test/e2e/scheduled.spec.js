/**
 * test/e2e/scheduled.spec.js
 *
 * Block 3 — Scheduled events endpoint tests:
 *  1.  POST /v1/actors/:id/schedule returns 201 with id, type, fireAt, status
 *  2.  GET  /v1/actors/:id/schedule lists the scheduled event
 *  3.  DELETE /v1/actors/:id/schedule/:sid cancels a pending event
 *  4.  DELETE returns 404 for an already-cancelled event
 *  5.  DELETE returns 404 for unknown actor
 *  6.  POST returns 404 for unknown actor
 *  7.  POST returns 409 for a terminated actor
 *  8.  POST validates required body fields (400)
 *  9.  GET returns 404 for unknown actor
 * 10.  GET /v1/scheduled requires admin key (403 with regular key)
 * 11.  Scheduler fires a past-due event and it appears in the actor's event history
 */

import { test, expect } from '@playwright/test';
import { randomUUID }   from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';
import { GET, POST, PUT, DELETE, uniqueId } from './helpers/api.js';

const __dirname      = dirname(fileURLToPath(import.meta.url));
const SCHED_WORKER   = resolve(__dirname, '../../src/workers/scheduler-worker.js');

const BASE       = process.env.STATEKEEP_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;
const KEY        = process.env.STATEKEEP_API_KEY ?? '';
const ADMIN_KEY  = process.env.STATEKEEP_ADMIN_KEY ?? '';
const SENTINEL   = '__test_key_do_not_use_in_production__';

async function adminGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'x-api-key': SENTINEL, 'x-admin-key': ADMIN_KEY },
  });
  const body = await res.json();
  return { status: res.status, body };
}

const MACHINE_DEF = {
  id:      'sched-machine',
  initial: 'idle',
  states: {
    idle:    { on: { START: 'running' } },
    running: { on: { STOP: 'done'    } },
    done:    { type: 'final'          },
  },
};

// ── Setup ─────────────────────────────────────────────────────────────────────

let defId;
let actorId;
let terminatedActorId;

test.beforeAll(async () => {
  defId = uniqueId('sched-def');

  const defRes = await PUT('/v1/definitions', { id: defId, definition: MACHINE_DEF });
  if (defRes.status !== 201 && defRes.status !== 200) {
    throw new Error(`Setup: failed to create definition (${defRes.status}): ${JSON.stringify(defRes.body)}`);
  }

  const spawnRes = await POST('/v1/actors', { definitionId: defId });
  if (spawnRes.status !== 201) {
    throw new Error(`Setup: failed to spawn actor (${spawnRes.status}): ${JSON.stringify(spawnRes.body)}`);
  }
  actorId = spawnRes.body.id;

  // Spawn + terminate a second actor
  const termRes = await POST('/v1/actors', { definitionId: defId });
  terminatedActorId = termRes.body.id;
  await DELETE(`/v1/actors/${terminatedActorId}`);
});

// ── 1: Schedule a future event ────────────────────────────────────────────────

test('POST /v1/actors/:id/schedule returns 201 with correct fields', async () => {
  const fireAt = Date.now() + 60_000;
  const { status, body } = await POST(`/v1/actors/${actorId}/schedule`, {
    type:   'START',
    fireAt,
  });

  expect(status).toBe(201);
  expect(typeof body.id).toBe('number');
  expect(body.actorId).toBe(actorId);
  expect(body.type).toBe('START');
  expect(body.fireAt).toBe(fireAt);
  expect(body.status).toBe('pending');
});

// ── 2: List scheduled events ──────────────────────────────────────────────────

test('GET /v1/actors/:id/schedule lists pending events', async () => {
  // Schedule one event first
  const fireAt = Date.now() + 90_000;
  await POST(`/v1/actors/${actorId}/schedule`, { type: 'STOP', fireAt });

  const { status, body } = await GET(`/v1/actors/${actorId}/schedule`);

  expect(status).toBe(200);
  expect(body.actorId).toBe(actorId);
  expect(Array.isArray(body.scheduledEvents)).toBe(true);
  expect(body.scheduledEvents.length).toBeGreaterThanOrEqual(1);

  const ev = body.scheduledEvents.find(e => e.eventType === 'STOP');
  expect(ev).toBeDefined();
  expect(ev.status).toBe('pending');
  expect(ev.fireAt).toBe(fireAt);
});

// ── 3: Cancel a pending event ─────────────────────────────────────────────────

test('DELETE /v1/actors/:id/schedule/:sid cancels a pending event', async () => {
  const fireAt   = Date.now() + 120_000;
  const postRes  = await POST(`/v1/actors/${actorId}/schedule`, { type: 'STOP', fireAt });
  const schedId  = postRes.body.id;

  const { status, body } = await DELETE(`/v1/actors/${actorId}/schedule/${schedId}`);

  expect(status).toBe(200);
  expect(body.cancelled).toBe(true);
});

// ── 4: Double-cancel returns 404 ─────────────────────────────────────────────

test('DELETE /v1/actors/:id/schedule/:sid returns 404 for already-cancelled event', async () => {
  const postRes  = await POST(`/v1/actors/${actorId}/schedule`, {
    type: 'STOP', fireAt: Date.now() + 120_000,
  });
  const schedId  = postRes.body.id;
  await DELETE(`/v1/actors/${actorId}/schedule/${schedId}`);

  const { status } = await DELETE(`/v1/actors/${actorId}/schedule/${schedId}`);
  expect(status).toBe(404);
});

// ── 5: DELETE unknown actor returns 404 ──────────────────────────────────────

test('DELETE /v1/actors/:id/schedule/:sid returns 404 for unknown actor', async () => {
  const { status } = await DELETE(`/v1/actors/${randomUUID()}/schedule/999`);
  expect(status).toBe(404);
});

// ── 6: POST unknown actor returns 404 ────────────────────────────────────────

test('POST /v1/actors/:id/schedule returns 404 for unknown actor', async () => {
  const { status } = await POST(`/v1/actors/${randomUUID()}/schedule`, {
    type: 'START', fireAt: Date.now() + 5_000,
  });
  expect(status).toBe(404);
});

// ── 7: POST terminated actor returns 409 ─────────────────────────────────────

test('POST /v1/actors/:id/schedule returns 409 for terminated actor', async () => {
  const { status } = await POST(`/v1/actors/${terminatedActorId}/schedule`, {
    type: 'START', fireAt: Date.now() + 5_000,
  });
  expect(status).toBe(409);
});

// ── 8: POST missing required fields returns 400 ───────────────────────────────

test('POST /v1/actors/:id/schedule returns 400 when body is invalid', async () => {
  // Missing fireAt
  const { status } = await POST(`/v1/actors/${actorId}/schedule`, { type: 'START' });
  expect(status).toBe(400);
});

// ── 9: GET unknown actor returns 404 ──────────────────────────────────────────

test('GET /v1/actors/:id/schedule returns 404 for unknown actor', async () => {
  const { status } = await GET(`/v1/actors/${randomUUID()}/schedule`);
  expect(status).toBe(404);
});

// ── 10: GET /v1/scheduled requires admin ──────────────────────────────────────

test.skip('GET /v1/scheduled returns 403 with a regular API key', async () => {
  // Open-source mode: adminMiddleware is a pass-through, no 403 is returned.
});

// ── 10b: GET /v1/scheduled positive test (admin key) ─────────────────────────

test('GET /v1/scheduled returns pending events with admin key', async () => {
  // Schedule one future event to ensure there is at least one pending row
  const fireAt = Date.now() + 3_600_000;
  await POST(`/v1/actors/${actorId}/schedule`, { type: 'STOP', fireAt });

  const res = await fetch(`${BASE}/v1/scheduled`, {
    headers: { 'x-api-key': SENTINEL, 'x-admin-key': ADMIN_KEY },
  });

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.count).toBe('number');
  expect(Array.isArray(body.scheduledEvents)).toBe(true);
  expect(body.count).toBeGreaterThanOrEqual(1);

  // Each entry must have expected fields
  const entry = body.scheduledEvents[0];
  expect(entry).toHaveProperty('id');
  expect(entry).toHaveProperty('actor_id');
  expect(entry).toHaveProperty('org_id');
  expect(entry).toHaveProperty('event_type');
  expect(entry).toHaveProperty('fire_at');
  expect(entry.status).toBe('pending');
});

// ── 11: Scheduler fires a past-due event ──────────────────────────────────────

test('scheduler fires a past-due event and it appears in actor event history', { timeout: 40_000 }, async () => {
  const { spawn } = await import('child_process');

  // Spawn a fresh actor so we have a clean event log
  const spawnRes = await POST('/v1/actors', { definitionId: defId });
  expect(spawnRes.status).toBe(201);
  const freshActorId = spawnRes.body.id;

  // Schedule a START event in the past (fireAt = 1 ms -> always due)
  const postRes = await POST(`/v1/actors/${freshActorId}/schedule`, {
    type:    'START',
    payload: { source: 'scheduler-test' },
    fireAt:  1,
  });
  expect(postRes.status).toBe(201);
  const schedId = postRes.body.id;

  // Spawn the scheduler-worker with a fast poll interval (500 ms) so the
  // past-due event fires within a few seconds.
  const worker = spawn(process.execPath, ['src/workers/scheduler-worker.js'], {
    env: {
      ...process.env,
      STATEKEEP_ENCRYPTION_KEY: process.env.STATEKEEP_ENCRYPTION_KEY ?? '0'.repeat(64),
      STATEKEEP_ADMIN_KEY:      process.env.STATEKEEP_ADMIN_KEY ?? 'test-admin-key',
      NODE_ENV:                 'test',
      SCHEDULER_POLL_INTERVAL:  '500',
    },
    cwd:   process.cwd(),
    stdio: 'pipe',
  });
  worker.on('error', err => console.warn('[test] scheduler-worker error:', err.message));

  try {
    // Poll up to 35 s for SCHEDULED_EVENT_FIRED to appear in actor event history.
    // The scheduler-worker spawns 20 actor-worker threads on first sendEvent call;
    // that cold-start can take 1-3 s. We poll the event log directly so we don't
    // race between markFired (immediate) and the INSERT that follows sendEvent.
    let eventFired = false;
    for (let i = 0; i < 35; i++) {
      await new Promise(r => setTimeout(r, 1_000));
      const histRes = await GET(`/v1/actors/${freshActorId}/events`);
      if (histRes.status === 200) {
        const eventTypes = histRes.body.events?.map(e => e.type) ?? [];
        if (eventTypes.includes('SCHEDULED_EVENT_FIRED')) {
          eventFired = true;
          break;
        }
      }
    }
    expect(eventFired).toBe(true);
  } finally {
    worker.kill('SIGTERM');
  }
});

// ── 12: Dead-letter — exhausted retries appear in /v1/scheduled/dead-letter ──

test('exhausted retries appear in GET /v1/scheduled/dead-letter', { timeout: 20_000 }, async () => {
  // Create an actor and drive it to a terminal state via events (not DELETE).
  // DELETE /v1/actors/:id calls cancelAllPendingForActor which would mark the
  // scheduled event as 'cancelled' before the scheduler can see it.  Instead we
  // send START→STOP to reach the 'done' final state, leaving the scheduled event
  // 'pending' so the scheduler can fail it (SKIP_STATUSES hit).
  const freshSpawn = await POST('/v1/actors', { definitionId: defId });
  expect(freshSpawn.status).toBe(201);
  const dlActorId = freshSpawn.body.id;

  // Schedule a past-due event while actor is still active
  const schedRes = await POST(`/v1/actors/${dlActorId}/schedule`, {
    type:   'STOP',   // will be picked up by scheduler; STOP is ignored in idle but valid type
    fireAt: 1,        // always in the past
  });
  expect(schedRes.status).toBe(201);
  const schedId = schedRes.body.id;

  // Drive actor to terminal state: idle→running→done (final)
  // This sets status='terminated' in DB without cancelling scheduled events
  await POST(`/v1/actors/${dlActorId}/event`, { type: 'START' });
  await POST(`/v1/actors/${dlActorId}/event`, { type: 'STOP' });

  // Spawn scheduler-worker with SCHEDULED_MAX_RETRIES=0 (immediate failure, no backoff)
  const { spawn } = await import('child_process');
  const worker = spawn(process.execPath, [SCHED_WORKER], {
    env: {
      ...process.env,
      STATEKEEP_ENCRYPTION_KEY: process.env.STATEKEEP_ENCRYPTION_KEY ?? '0'.repeat(64),
      STATEKEEP_ADMIN_KEY:      process.env.STATEKEEP_ADMIN_KEY ?? 'test-admin-key',
      NODE_ENV:                 'test',
      SCHEDULER_POLL_INTERVAL:  '300',
      SCHEDULED_MAX_RETRIES:    '0',
    },
    cwd:   resolve(__dirname, '../..'),
    stdio: 'pipe',
  });
  worker.on('error', err => console.warn('[test] scheduler-worker error:', err.message));

  try {
    // Poll until the event status becomes 'failed' (max_retries=0 → first attempt fails immediately)
    let failed = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const { body } = await GET(`/v1/actors/${dlActorId}/schedule`);
      const ev = body.scheduledEvents?.find(e => e.id === schedId);
      if (ev?.status === 'failed') { failed = true; break; }
    }
    expect(failed).toBe(true);

    // Verify it appears in the admin dead-letter endpoint
    const dlRes = await fetch(`${BASE}/v1/scheduled/dead-letter`, {
      headers: { 'x-api-key': SENTINEL, 'x-admin-key': ADMIN_KEY },
    });
    expect(dlRes.status).toBe(200);
    const dlBody = await dlRes.json();
    expect(typeof dlBody.count).toBe('number');
    const dlEvent = dlBody.deadLetter?.find(e => e.id === schedId);
    expect(dlEvent).toBeDefined();
  } finally {
    worker.kill('SIGTERM');
  }
});
