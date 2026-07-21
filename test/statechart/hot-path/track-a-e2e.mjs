/**
 * Track A E2E Verification
 *
 * Tests the three hot-path features via createStateKeep (in-process, no HTTP):
 *   1. Guards — filter transitions correctly
 *   2. after: — staleEntryId guard works; timeout event transitions actor
 *   3. invoke — service fires, done event transitions actor and populates context
 *
 * Run with:
 *   node test/statechart/hot-path/track-a-e2e.mjs
 */

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateKeep } from '../../../src/lib/index.js';

const DB = join(tmpdir(), `track-a-e2e-${Date.now()}.db`);

// ── Setup ─────────────────────────────────────────────────────────────────────

const sk = await createStateKeep({
  dbPath: DB,
  encryptionKey: '0'.repeat(64),
  setup: {
    machines: {
      all: {
        setup: {
          guards: {
            isScoreHigh: ({ context }) => context.score >= 700,
          },
          actions: {
            recordApproval: ({ context, event }) => {
              context.approvedAt = Date.now();
              context.creditResult = event.output ?? event.data;
            },
          },
          services: {
            creditCheck: async ({ context }) => {
              await new Promise(r => setTimeout(r, 80));
              return { approved: true, limit: context.score >= 700 ? 10000 : 1000 };
            },
          },
        },
      },
    },
  },
});

// ── Test 1: Guards ─────────────────────────────────────────────────────────────

{
  const { id: defId } = await sk.deployDefinition({
    id: 'guard-test', initial: 'idle',
    states: {
      idle: {
        on: {
          SUBMIT: [
            { target: 'approved', guard: 'isScoreHigh' },
            { target: 'rejected' },
          ],
        },
      },
      approved: { type: 'final' },
      rejected:  { type: 'final' },
    },
  });

  // Low score → guard fails → rejected
  const low = await sk.spawnActor({ definitionId: defId, context: { score: 500 } });
  const r1 = await sk.sendEvent(low.id, { type: 'SUBMIT' });
  assert.equal(r1.stateValue, 'rejected', 'guard: low score should go to rejected');
  assert.equal(r1.done, true);
  console.log('✓ Guard 1: low score (500) → rejected');

  // High score → guard passes → approved
  const high = await sk.spawnActor({ definitionId: defId, context: { score: 750 } });
  const r2 = await sk.sendEvent(high.id, { type: 'SUBMIT' });
  assert.equal(r2.stateValue, 'approved', 'guard: high score should go to approved');
  assert.equal(r2.done, true);
  console.log('✓ Guard 2: high score (750) → approved');
}

// ── Test 2: after: ─────────────────────────────────────────────────────────────

{
  const { id: defId } = await sk.deployDefinition({
    id: 'after-test', initial: 'idle',
    states: {
      idle:      { on: { START: 'waiting' } },
      waiting:   { after: { 30000: 'timed_out' }, on: { CANCEL: 'cancelled' } },
      timed_out: { type: 'final' },
      cancelled: { type: 'final' },
    },
  });

  const actor = await sk.spawnActor({ definitionId: defId, context: {} });
  // Enter the waiting state — stateEntryId is in the return value
  const r1 = await sk.sendEvent(actor.id, { type: 'START' });
  assert.equal(r1.stateValue, 'waiting');
  assert.ok(r1.stateEntryId != null, 'sendEvent should return stateEntryId');
  console.log(`✓ after: actor entered waiting state (stateEntryId=${r1.stateEntryId})`);

  // Stale guard: fire timeout with WRONG stateEntryId — must be ignored
  const stale = await sk.sendEvent(actor.id, {
    type: '__SK_TIMEOUT_waiting_30000',
    stateEntryId: r1.stateEntryId + 999,  // wrong id
  });
  assert.equal(stale.stateValue, 'waiting', 'stale timeout should be discarded');
  console.log('✓ after: stale timeout (wrong stateEntryId) discarded — still in waiting');

  // Fire timeout with CORRECT stateEntryId — should transition
  const r2 = await sk.sendEvent(actor.id, {
    type: '__SK_TIMEOUT_waiting_30000',
    stateEntryId: r1.stateEntryId,
  });
  assert.equal(r2.stateValue, 'timed_out', 'valid timeout should transition to timed_out');
  assert.equal(r2.done, true);
  console.log('✓ after: valid timeout event → timed_out (final)');
}

// ── Test 3: invoke ─────────────────────────────────────────────────────────────

{
  const { id: defId } = await sk.deployDefinition({
    id: 'invoke-test', initial: 'idle',
    states: {
      idle: { on: { CHECK: 'checking' } },
      checking: {
        invoke: {
          id: 'credit',
          src: 'creditCheck',
          onDone:  { target: 'approved', actions: ['recordApproval'] },
          onError: { target: 'rejected' },
        },
      },
      approved: { type: 'final' },
      rejected:  { type: 'final' },
    },
  });

  const actor = await sk.spawnActor({ definitionId: defId, context: { score: 800 } });
  const r1 = await sk.sendEvent(actor.id, { type: 'CHECK' });
  assert.equal(r1.stateValue, 'checking', 'invoke: actor should enter checking state');
  console.log('✓ invoke: actor entered checking (service started)');

  // Wait for creditCheck (~80ms) + done.invoke event to be dispatched
  await new Promise(r => setTimeout(r, 400));

  const final = await sk.getActor(actor.id);
  assert.equal(final.stateValue, 'approved', 'invoke: done event should transition to approved');
  assert.ok(final.context?.approvedAt, 'invoke: recordApproval action should set approvedAt');
  assert.ok(final.context?.creditResult?.approved === true, 'invoke: output data in context');
  console.log('✓ invoke: creditCheck resolved → approved (context.creditResult populated)');
}

// ── Teardown ──────────────────────────────────────────────────────────────────

await sk.close();

console.log('\n══════════════════════════════════════════════════');
console.log('  ✓ Track A E2E: ALL CHECKS PASSED');
console.log('══════════════════════════════════════════════════');
