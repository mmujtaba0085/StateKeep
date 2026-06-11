/**
 * test/statechart/sc14.complex-migration-scenarios.js
 *
 * Worker-level migration scenarios for cases that are easy to miss in HTTP tests:
 * broken target versions, rescue/corrected versions, context transform failures,
 * stale worker replacement, and nested parallel region preservation.
 *
 * Run: node --test test/statechart/sc14.complex-migration-scenarios.js
 */

import { Worker } from 'node:worker_threads';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeHistoryHash } from '../../src/ffi/hashUtils.js';

const WORKER_URL = new URL('../../src/runtime/actorWorker.js', import.meta.url);

async function startWorker() {
  const worker = new Worker(WORKER_URL, { type: 'module' });
  let nextId = 1;
  const pending = new Map();

  const ready = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (msg) => {
      if (msg.id === '__ready__') {
        resolve();
        return;
      }

      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.result);
      else waiter.reject(new Error(msg.error));
    });
  });

  await ready;

  return {
    send(payload) {
      const id = `msg-${nextId++}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, ...payload });
      });
    },
    async close() {
      for (const { reject } of pending.values()) reject(new Error('worker closed'));
      pending.clear();
      await worker.terminate();
    },
  };
}

async function withWorker(fn) {
  const worker = await startWorker();
  try {
    await fn(worker);
  } finally {
    await worker.close();
  }
}

const DOC_V1 = {
  id: 'document',
  initial: 'draft',
  context: {
    version: 1,
    user: { id: null },
    audit: {},
  },
  states: {
    draft: { on: { SUBMIT: 'review' } },
    review: { on: { APPROVE: 'approved', REJECT: 'rejected' } },
    approved: { on: { ARCHIVE: 'archived' } },
    rejected: { on: { REVISE: 'draft' } },
    archived: { type: 'final' },
  },
};

const DOC_BROKEN_V2 = {
  id: 'document',
  initial: 'draft',
  context: DOC_V1.context,
  states: {
    draft: { on: { SUBMIT: 'triage' } },
    triage: { on: { APPROVE: 'approved' } },
    approved: { on: { ARCHIVE: 'archived' } },
    archived: { type: 'final' },
  },
};

const DOC_FIXED_V2 = {
  id: 'document',
  initial: 'draft',
  context: DOC_V1.context,
  states: {
    draft: { on: { SUBMIT: 'checking' } },
    checking: { on: { APPROVE: 'approved', ESCALATE: 'manual' } },
    manual: { on: { APPROVE: 'approved', REJECT: 'rejected' } },
    approved: { on: { ARCHIVE: 'archived' } },
    rejected: { on: { REVISE: 'draft' } },
    archived: { type: 'final' },
  },
};

const CHECKOUT_V1 = {
  id: 'checkout',
  initial: 'active',
  states: {
    active: {
      type: 'parallel',
      on: { COMPLETE: 'done' },
      states: {
        payment: {
          initial: 'unpaid',
          states: {
            unpaid: { on: { PAY: 'paid' } },
            paid: {},
          },
        },
        shipping: {
          initial: 'unselected',
          states: {
            unselected: { on: { SELECT_SHIPPING: 'selected' } },
            selected: {},
          },
        },
      },
    },
    done: { type: 'final' },
  },
};

const CHECKOUT_BROKEN_V2 = {
  id: 'checkout',
  initial: 'live',
  states: {
    live: {
      type: 'parallel',
      on: { COMPLETE: 'done' },
      states: CHECKOUT_V1.states.active.states,
    },
    done: { type: 'final' },
  },
};

const CHECKOUT_FIXED_V2 = {
  id: 'checkout',
  initial: 'active',
  states: {
    active: {
      type: 'parallel',
      on: { COMPLETE: 'done' },
      states: {
        payment: {
          initial: 'unpaid',
          states: {
            unpaid: { on: { PAY: 'paid', APPLY_COUPON: 'discounted' } },
            discounted: { on: { PAY: 'paid' } },
            paid: {},
          },
        },
        shipping: {
          initial: 'unselected',
          states: {
            unselected: { on: { SELECT_SHIPPING: 'selected' } },
            selected: { on: { CHANGE_SHIPPING: 'unselected' } },
          },
        },
      },
    },
    done: { type: 'final' },
  },
};

describe('SC14-A: broken version then corrected version', () => {
  test('failed hydrate does not lose the ability to rescue with a corrected target', async () => {
    await withWorker(async (worker) => {
      const actorId = 'doc-broken-then-fixed';
      const initialContext = {
        version: 1,
        user: { id: 'user-17' },
        audit: { source: 'v1' },
      };

      const spawned = await worker.send({
        type: 'SPAWN',
        actorId,
        definitionId: 'doc-v1',
        definitionJson: DOC_V1,
        initialContext,
      });
      assert.equal(spawned.stateValue, 'draft');

      const submitted = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'SUBMIT' },
        historyFingerprint: '0',
      });
      assert.equal(submitted.stateValue, 'review');
      assert.equal(submitted.historyFingerprint, computeHistoryHash(['SUBMIT']));

      const broken = await worker.send({
        type: 'HYDRATE',
        actorId,
        targetDefinitionId: 'doc-broken-v2',
        targetDefinitionJson: DOC_BROKEN_V2,
        oldContext: submitted.context,
        currentStateValue: submitted.stateValue,
        existingFingerprint: submitted.historyFingerprint,
      });
      assert.equal(broken.error, 'STATE_NOT_MAPPABLE');
      assert.equal(broken.currentStateValue, 'review');

      const corrected = await worker.send({
        type: 'HYDRATE',
        actorId,
        targetDefinitionId: 'doc-fixed-v2',
        targetDefinitionJson: DOC_FIXED_V2,
        oldContext: submitted.context,
        currentStateValue: submitted.stateValue,
        stateMapping: { review: 'checking' },
        contextTransform: {
          'audit.originalUserId': 'user.id',
          'audit.previousVersion': 'version',
        },
        existingFingerprint: submitted.historyFingerprint,
      });

      assert.equal(corrected.stateValue, 'checking');
      assert.equal(corrected.historyFingerprint, submitted.historyFingerprint);
      assert.equal(corrected.context.user.id, 'user-17');
      assert.equal(corrected.context.audit.source, 'v1');
      assert.equal(corrected.context.audit.originalUserId, 'user-17');
      assert.equal(corrected.context.audit.previousVersion, 1);

      const escalated = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'ESCALATE' },
        historyFingerprint: corrected.historyFingerprint,
      });
      assert.equal(escalated.stateValue, 'manual');
      assert.equal(escalated.historyFingerprint, computeHistoryHash(['SUBMIT', 'ESCALATE']));

      const approved = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'APPROVE' },
        historyFingerprint: escalated.historyFingerprint,
      });
      assert.equal(approved.stateValue, 'approved');
      assert.equal(approved.historyFingerprint, computeHistoryHash(['SUBMIT', 'ESCALATE', 'APPROVE']));
    });
  });
});

describe('SC14-B: transform failures and retry behavior', () => {
  test('bad context transform reports failure, then the same state can migrate with corrected context', async () => {
    await withWorker(async (worker) => {
      const actorId = 'doc-corrupt-context-then-fixed';

      await worker.send({
        type: 'SPAWN',
        actorId,
        definitionId: 'doc-v1',
        definitionJson: DOC_V1,
      });
      const submitted = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'SUBMIT' },
        historyFingerprint: '0',
      });

      const failed = await worker.send({
        type: 'HYDRATE',
        actorId,
        targetDefinitionId: 'doc-fixed-v2',
        targetDefinitionJson: DOC_FIXED_V2,
        oldContext: 'corrupt-context',
        currentStateValue: submitted.stateValue,
        stateMapping: { review: 'checking' },
        contextTransform: { 'audit.originalUserId': 'user.id' },
        existingFingerprint: submitted.historyFingerprint,
      });
      assert.equal(failed.error, 'CONTEXT_TRANSFORM_FAILED');
      assert.match(failed.message, /context must be a non-null object/);

      const retried = await worker.send({
        type: 'HYDRATE',
        actorId,
        targetDefinitionId: 'doc-fixed-v2',
        targetDefinitionJson: DOC_FIXED_V2,
        oldContext: { version: 1, user: { id: 'user-99' }, audit: {} },
        currentStateValue: submitted.stateValue,
        stateMapping: { review: 'checking' },
        contextTransform: { 'audit.originalUserId': 'user.id' },
        existingFingerprint: submitted.historyFingerprint,
      });
      assert.equal(retried.stateValue, 'checking');
      assert.equal(retried.context.audit.originalUserId, 'user-99');
      assert.equal(retried.historyFingerprint, submitted.historyFingerprint);
    });
  });
});

describe('SC14-C: nested parallel migration safety', () => {
  test('parallel state survives rescue and region fingerprints stay path-specific', async () => {
    await withWorker(async (worker) => {
      const actorId = 'checkout-parallel-rescue';

      const spawned = await worker.send({
        type: 'SPAWN',
        actorId,
        definitionId: 'checkout-v1',
        definitionJson: CHECKOUT_V1,
      });
      assert.deepEqual(spawned.stateValue, {
        active: { payment: 'unpaid', shipping: 'unselected' },
      });
      assert.deepEqual(spawned.regionFingerprints, {
        'active.payment': '0',
        'active.shipping': '0',
      });

      const paid = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'PAY' },
        historyFingerprint: '0',
        regionFingerprints: spawned.regionFingerprints,
      });
      assert.deepEqual(paid.stateValue, {
        active: { payment: 'paid', shipping: 'unselected' },
      });
      assert.equal(paid.regionFingerprints['active.payment'], computeHistoryHash(['PAY']));
      assert.equal(paid.regionFingerprints['active.shipping'], '0');

      const broken = await worker.send({
        type: 'HYDRATE',
        actorId,
        targetDefinitionId: 'checkout-broken-v2',
        targetDefinitionJson: CHECKOUT_BROKEN_V2,
        oldContext: paid.context,
        currentStateValue: paid.stateValue,
        existingFingerprint: paid.historyFingerprint,
        existingRegionFingerprints: paid.regionFingerprints,
      });
      assert.equal(broken.error, 'STATE_NOT_MAPPABLE');
      assert.deepEqual(broken.currentStateValue, paid.stateValue);

      const corrected = await worker.send({
        type: 'HYDRATE',
        actorId,
        targetDefinitionId: 'checkout-fixed-v2',
        targetDefinitionJson: CHECKOUT_FIXED_V2,
        oldContext: paid.context,
        currentStateValue: paid.stateValue,
        existingFingerprint: paid.historyFingerprint,
        existingRegionFingerprints: paid.regionFingerprints,
      });
      assert.deepEqual(corrected.stateValue, paid.stateValue);
      assert.deepEqual(corrected.regionFingerprints, paid.regionFingerprints);
      assert.equal(corrected.historyFingerprint, paid.historyFingerprint);

      const selected = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'SELECT_SHIPPING' },
        historyFingerprint: corrected.historyFingerprint,
        regionFingerprints: corrected.regionFingerprints,
      });
      assert.deepEqual(selected.stateValue, {
        active: { payment: 'paid', shipping: 'selected' },
      });
      assert.equal(selected.regionFingerprints['active.payment'], paid.regionFingerprints['active.payment']);
      assert.equal(selected.regionFingerprints['active.shipping'], computeHistoryHash(['SELECT_SHIPPING']));

      const completed = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'COMPLETE' },
        historyFingerprint: selected.historyFingerprint,
        regionFingerprints: selected.regionFingerprints,
      });
      assert.equal(completed.stateValue, 'done');
      assert.equal(completed.regionFingerprints, null);
      assert.equal(
        completed.historyFingerprint,
        computeHistoryHash(['PAY', 'SELECT_SHIPPING', 'COMPLETE'])
      );
    });
  });
});
