/** Loan scenario from the server tests, reproduced with plain XState actors. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine, assign } from 'xstate';
import { createVersionRouter } from './index.js';

const base = {
  id: 'loan', initial: 'draft', context: ({ input }) => ({ ...(input ?? {}) }),
};
const v1 = createMachine({ ...base, states: {
  draft: { on: { SUBMIT: 'review' } },
  review: { on: { APPROVE: 'approved', REJECT: 'rejected', REQUEST_INFO: 'info_needed' } },
  info_needed: { on: { RESUBMIT: 'review' } },
  approved: { on: { DISBURSE: 'disbursed' } }, disbursed: { type: 'final' }, rejected: { type: 'final' },
} });
const v2 = createMachine({ ...base, states: {
  draft: { on: { SUBMIT: 'review' } },
  review: { on: { APPROVE: 'compliance_check', REJECT: 'rejected', REQUEST_INFO: 'awaiting_documents' } },
  awaiting_documents: { on: { RESUBMIT: 'review' } },
  compliance_check: { on: { CLEARED: 'approved' } },
  approved: { on: { DISBURSE: 'disbursed' } }, disbursed: { type: 'final' }, rejected: { type: 'final' },
} });
const v3 = createMachine({ ...base, states: {
  draft: { on: { SUBMIT: 'review' } },
  review: { on: { APPROVE: 'senior_review', REJECT: 'rejected', REQUEST_INFO: 'awaiting_documents' } },
  senior_review: { on: { SIGN_OFF: 'compliance_check' } },
  awaiting_documents: { on: { RESUBMIT: 'review' } },
  compliance_check: { on: { CLEARED: 'approved' } },
  approved: { on: { DISBURSE: 'disbursed' } }, disbursed: { type: 'final' }, rejected: { type: 'final' },
} });

const walk = (router, rec, events) => events.reduce((r, type) => router.send(r, { type }), rec);

test('full release moves everyone, maps renamed states, copies context', () => {
  const only1 = createVersionRouter({ versions: { 'loan-v1': v1 } });
  const saved = {
    hina:  only1.persist(walk(only1, only1.start('loan-v1', { amount: 3 }), ['SUBMIT', 'REQUEST_INFO'])),
    bilal: only1.persist(walk(only1, only1.start('loan-v1', { amount: 9 }), ['SUBMIT'])),
  };
  const router = createVersionRouter({
    versions: { 'loan-v1': v1, 'loan-v2': v2 },
    releases: [{ from: 'loan-v1', to: 'loan-v2', stateMapping: { info_needed: 'awaiting_documents' }, contextTransform: { loanAmount: 'amount' } }],
  });
  const hina = router.restore(saved.hina);
  assert.equal(hina.version, 'loan-v2');
  assert.equal(hina.actor.getSnapshot().value, 'awaiting_documents');
  assert.equal(hina.actor.getSnapshot().context.loanAmount, 3);
  const bilal = router.send(router.restore(saved.bilal), { type: 'APPROVE' });
  assert.equal(bilal.actor.getSnapshot().value, 'compliance_check', 'new rule applies after migration');
});

test('refuses to strand: removed state without mapping stays put and is reported', () => {
  const only1 = createVersionRouter({ versions: { 'loan-v1': v1 } });
  const saved = only1.persist(walk(only1, only1.start('loan-v1'), ['SUBMIT', 'REQUEST_INFO']));
  const router = createVersionRouter({ versions: { 'loan-v1': v1, 'loan-v2': v2 }, releases: [{ from: 'loan-v1', to: 'loan-v2' }] });
  const plan = router.plan([saved]);
  assert.equal(plan.stranded.length, 1);
  assert.match(plan.stranded[0].reason, /info_needed/);
  const rec = router.restore(saved);
  assert.equal(rec.version, 'loan-v1');
  assert.ok(rec.stranded);
  assert.equal(rec.actor.getSnapshot().value, 'info_needed');
});

test('history-targeted release: same state, different history → different outcome', () => {
  const r2 = createVersionRouter({ versions: { 'loan-v2': v2 } });
  const bilal = r2.persist(walk(r2, r2.start('loan-v2'), ['SUBMIT']));
  const hina  = r2.persist(walk(r2, r2.start('loan-v2'), ['SUBMIT', 'REQUEST_INFO', 'RESUBMIT']));
  const kamran = r2.persist(walk(r2, r2.start('loan-v2'), ['SUBMIT', 'REQUEST_INFO', 'RESUBMIT', 'APPROVE']));
  const nadiaStart = r2.persist(r2.start('loan-v2'));
  const router = createVersionRouter({
    versions: { 'loan-v2': v2, 'loan-v3': v3 },
    releases: [{ from: 'loan-v2', to: 'loan-v3', historyPath: ['SUBMIT', 'REQUEST_INFO', 'RESUBMIT'] }],
  });
  const plan = router.plan([bilal, hina, kamran]);
  assert.deepEqual(plan.moves.map((m) => m.index), [1]);
  assert.deepEqual(plan.stays.map((m) => m.index).sort(), [0, 2], 'kamran already past the point: not retroactive');

  const b = router.send(router.restore(bilal), { type: 'APPROVE' });
  const h = router.send(router.restore(hina), { type: 'APPROVE' });
  assert.equal(b.actor.getSnapshot().value, 'compliance_check');
  assert.equal(h.actor.getSnapshot().value, 'senior_review');

  // Nadia reaches the path AFTER the release: moved just before her next event
  let n = router.restore(nadiaStart);
  n = walk(router, n, ['SUBMIT', 'REQUEST_INFO', 'RESUBMIT']);
  assert.equal(n.version, 'loan-v2');
  n = router.send(n, { type: 'APPROVE' });
  assert.equal(n.version, 'loan-v3');
  assert.equal(n.actor.getSnapshot().value, 'senior_review');
});

test('releases chain v1 → v2 → v3 and persist/restore round-trips', () => {
  const only1 = createVersionRouter({ versions: { 'loan-v1': v1 } });
  const saved = only1.persist(walk(only1, only1.start('loan-v1'), ['SUBMIT']));
  const router = createVersionRouter({
    versions: { 'loan-v1': v1, 'loan-v2': v2, 'loan-v3': v3 },
    releases: [{ from: 'loan-v1', to: 'loan-v2' }, { from: 'loan-v2', to: 'loan-v3' }],
  });
  const rec = router.restore(saved);
  assert.equal(rec.version, 'loan-v3');
  assert.deepEqual(rec.migrations, ['loan-v1→loan-v2', 'loan-v2→loan-v3']);
  const again = router.restore(JSON.parse(JSON.stringify(router.persist(rec))));
  assert.equal(again.version, 'loan-v3');
  assert.equal(again.actor.getSnapshot().value, 'review');
});

test('unsafe contextTransform paths are rejected', () => {
  assert.throws(() => createVersionRouter({ versions: { a: v1, b: v2 }, releases: [{ from: 'a', to: 'b', contextTransform: { '__proto__.x': 'y' } }] }));
});
