/**
 * sdk/test/client.test.js
 * Integration tests for StateKeepClient.
 * Requires a live server — set STATEKEEP_URL and STATEKEEP_API_KEY.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

const API_KEY  = process.env.STATEKEEP_API_KEY;
const BASE_URL = process.env.STATEKEEP_URL ?? 'http://localhost:3001';
const SKIP     = !API_KEY;

if (SKIP) console.log('STATEKEEP_API_KEY not set — skipping SDK tests');

// Polling helper — no fixed delays
async function waitUntil(fn, timeoutMs = 10_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
}

async function waitForState(sk, actorId, targetState) {
  await waitUntil(async () => {
    const s = await sk.getState(actorId);
    const v = typeof s.stateValue === 'string'
      ? s.stateValue
      : Object.keys(s.stateValue ?? {})[0];
    return v === targetState;
  }, 10_000, 200);
}

const MACHINE = {
  id: 'sdk-test', initial: 'idle',
  states: {
    idle:    { on: { START: 'working' } },
    working: { on: { COMPLETE: 'done', FAIL: 'failed' } },
    done:    { type: 'final' },
    failed:  { type: 'final' },
  },
};

describe('StateKeepClient', { skip: SKIP }, async () => {
  let sk;
  let createClient, StateKeepError;

  before(async () => {
    const mod = await import('../src/index.ts').catch(
                  () => import('../src/index.js'));
    createClient   = mod.createClient;
    StateKeepError = mod.StateKeepError;
    sk = createClient({ baseUrl: BASE_URL, apiKey: API_KEY });
  });

  test('health() returns ok', async () => {
    const r = await sk.health();
    assert.equal(r.status, 'ok');
  });

  test('validate() returns valid for correct machine', async () => {
    const r = await sk.validate(MACHINE);
    assert.equal(r.valid, true);
    assert.ok(r.states.includes('idle'));
  });

  test('validate() returns invalid for broken machine', async () => {
    const r = await sk.validate({ id: 'bad', initial: 'ghost', states: {} });
    assert.equal(r.valid, false);
    assert.ok(r.errors.length > 0);
  });

  test('deploy() creates a definition', async () => {
    const id = `sdk-${Date.now()}`;
    const r  = await sk.deploy(id, MACHINE);
    assert.equal(r.id, id);
    assert.equal(r.idempotent, false);
    assert.ok(r.deployedAt > 0);

    // Re-deploy same definition — must be idempotent
    const r2 = await sk.deploy(id, MACHINE);
    assert.equal(r2.idempotent, true);
  });

  test('spawn() creates actor in initial state', async () => {
    const defId = `sdk-spawn-${Date.now()}`;
    await sk.deploy(defId, MACHINE);
    const actor = await sk.spawn(defId, { testRun: true });
    assert.ok(actor.actorId);
    assert.equal(actor.stateValue, 'idle');
    assert.equal(actor.definitionId, defId);
    assert.equal(actor.done, false);
  });

  test('send() transitions actor state', async () => {
    const defId = `sdk-send-${Date.now()}`;
    await sk.deploy(defId, MACHINE);
    const actor = await sk.spawn(defId);
    const after = await sk.send(actor.actorId, 'START');
    assert.equal(after.stateValue, 'working');
    assert.equal(after.done, false);
  });

  test('send() with idempotencyKey does not double-process', async () => {
    const defId = `sdk-idem-${Date.now()}`;
    await sk.deploy(defId, MACHINE);
    const actor = await sk.spawn(defId);

    const r1 = await sk.send(actor.actorId, 'START', {}, 'idem-key-001');
    assert.equal(r1.stateValue, 'working');

    const r2 = await sk.send(actor.actorId, 'START', {}, 'idem-key-001');
    assert.equal(r2.idempotent, true);
    assert.equal(r2.stateValue, 'working'); // not double-transitioned
  });

  test('send() to final state sets done=true', async () => {
    const defId = `sdk-done-${Date.now()}`;
    await sk.deploy(defId, MACHINE);
    const actor = await sk.spawn(defId);
    await sk.send(actor.actorId, 'START');
    const fin   = await sk.send(actor.actorId, 'COMPLETE');
    assert.equal(fin.stateValue, 'done');
    assert.equal(fin.done, true);
  });

  test('getState() returns current state', async () => {
    const defId = `sdk-getstate-${Date.now()}`;
    await sk.deploy(defId, MACHINE);
    const actor  = await sk.spawn(defId);
    await sk.send(actor.actorId, 'START');
    const state  = await sk.getState(actor.actorId);
    assert.equal(state.stateValue, 'working');
    // Fingerprint must be non-empty after processing an event
    assert.ok(state.historyFingerprint);
    // Do NOT assert fingerprint format, length, or encoding
  });

  test('getEvents() returns event history with pagination', async () => {
    const defId = `sdk-events-${Date.now()}`;
    await sk.deploy(defId, MACHINE);
    const actor  = await sk.spawn(defId);
    await sk.send(actor.actorId, 'START');
    await sk.send(actor.actorId, 'COMPLETE');

    const r = await sk.getEvents(actor.actorId, { limit: 2 });
    assert.ok(Array.isArray(r.events));
    assert.ok(r.events.length > 0);
    assert.ok('hasMore' in r);
    assert.ok('nextCursor' in r);
  });

  test('terminate() marks actor terminated', async () => {
    const defId = `sdk-term-${Date.now()}`;
    await sk.deploy(defId, MACHINE);
    const actor = await sk.spawn(defId);
    await sk.terminate(actor.actorId);
    const state = await sk.getState(actor.actorId);
    assert.equal(state.status, 'terminated');
  });

  test('StateKeepError thrown on 404', async () => {
    await assert.rejects(
      () => sk.getState('does-not-exist-xyz'),
      (err) => {
        assert.equal(err.name, 'StateKeepError');
        assert.equal(err.status, 404);
        return true;
      }
    );
  });

  test('preview() returns migration analysis without writing definition', async () => {
    const defId     = `sdk-preview-${Date.now()}`;
    await sk.deploy(defId, MACHINE);
    const previewId = `${defId}-v2-preview`;
    const v2def     = { ...MACHINE, states: { ...MACHINE.states,
      review: { type: 'final' } } };

    const r = await sk.preview(previewId, v2def, { parentId: defId });
    assert.ok('wouldDeploy' in r);
    assert.ok('migration' in r);

    // Definition must NOT have been written
    await assert.rejects(
      () => sk.getDefinition(previewId),
      (err) => {
        assert.equal(err.status, 404);
        return true;
      }
    );
  });

  test('schedule() creates pending scheduled event', async () => {
    const defId = `sdk-sched-${Date.now()}`;
    await sk.deploy(defId, MACHINE);
    const actor = await sk.spawn(defId);
    const sched = await sk.schedule(actor.actorId, 'START', { delay: 300_000 });
    assert.equal(sched.status, 'pending');
    assert.equal(sched.eventType, 'START');
    // Clean up
    await sk.cancelScheduled(actor.actorId, sched.id);
    await sk.terminate(actor.actorId);
  });

  test('listActors() returns actors array', async () => {
    const r = await sk.listActors({ limit: 5 });
    assert.ok(Array.isArray(r.actors));
    assert.ok(typeof r.count === 'number');
  });
});
