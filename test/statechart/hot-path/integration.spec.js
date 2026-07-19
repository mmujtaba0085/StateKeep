import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStateKeep } from '../../../src/lib/index.js';

// Uses an in-memory DB path so each test run is isolated
let sk;

test.before(async () => {
  sk = await createStateKeep({
    dbPath: ':memory:',
    setup: {
      machines: {
        'loan-test': {
          setup: {
            guards: { isScoreValid: ({ context }) => context.score >= 700 },
            actions: {},
            services: {},
          },
        },
      },
    },
  });
});

test.after(async () => { await sk.close(); });

test('simple transition via main-thread interpreter', async () => {
  const def = {
    id: 'loan-test', initial: 'idle',
    states: {
      idle:     { on: { SUBMIT: 'review' } },
      review:   { on: { APPROVE: { target: 'approved', guard: 'isScoreValid' }, REJECT: 'rejected' } },
      approved: { type: 'final' },
      rejected: { type: 'final' },
    },
  };
  const { id: defId } = await sk.deployDefinition(def);
  const actor = await sk.spawnActor({ definitionId: defId, context: { score: 750 } });
  assert.equal(actor.stateValue, 'idle');

  const r1 = await sk.sendEvent(actor.id, { type: 'SUBMIT' });
  assert.equal(r1.stateValue, 'review');

  const r2 = await sk.sendEvent(actor.id, { type: 'APPROVE' });
  assert.equal(r2.stateValue, 'approved');
  assert.equal(r2.done, true);
});

test('guarded transition falls through when guard fails', async () => {
  const def = {
    id: 'loan-test-2', initial: 'idle',
    states: {
      idle:     { on: { SUBMIT: 'review' } },
      review:   { on: { APPROVE: [{ target: 'approved', guard: 'isScoreValid' }, { target: 'rejected' }] } },
      approved: { type: 'final' },
      rejected: { type: 'final' },
    },
  };
  const { id: defId } = await sk.deployDefinition(def);
  const actor = await sk.spawnActor({ definitionId: defId, context: { score: 500 } });
  await sk.sendEvent(actor.id, { type: 'SUBMIT' });
  const r = await sk.sendEvent(actor.id, { type: 'APPROVE' });
  assert.equal(r.stateValue, 'rejected');
});
