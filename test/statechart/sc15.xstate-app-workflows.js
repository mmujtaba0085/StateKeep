/**
 * test/statechart/sc15.xstate-app-workflows.js
 *
 * XState-native product workflow examples:
 * - a simple onboarding wizard gains a new step without losing the active state
 * - a support form migrates through a broken version and then a corrected rescue version
 * - a parallel setup flow tracks independent UI regions by full path
 * - region selectors are shown as completed UI sections, not finance or developer ops
 *
 * Run: node --test test/statechart/sc15.xstate-app-workflows.js
 */

import { Worker } from 'node:worker_threads';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeHistoryHash,
  computeRegionHashes,
  regionFingerprintsToArray,
} from '../../src/ffi/hashUtils.js';

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

function bigintSet(values) {
  return new Set(values.map(value => value.toString()));
}

function selectorSet(historyRegions) {
  return bigintSet(regionFingerprintsToArray(computeRegionHashes(historyRegions)));
}

function actorSet(regionFingerprints) {
  return bigintSet(regionFingerprintsToArray(regionFingerprints));
}

function isSubset(selector, actor) {
  for (const value of selector) {
    if (!actor.has(value)) return false;
  }
  return true;
}

const ONBOARDING_V1 = {
  id: 'onboarding-wizard',
  initial: 'intro',
  context: {
    profile: { name: null, avatarId: null },
    preferences: {},
    audit: {},
  },
  states: {
    intro: { on: { START: 'profile' } },
    profile: {
      initial: 'basics',
      states: {
        basics: { on: { SAVE_BASICS: 'avatar' } },
        avatar: { on: { UPLOAD_AVATAR: '#onboarding-wizard.review' } },
      },
    },
    review: { on: { SUBMIT: 'submitted' } },
    submitted: { type: 'final' },
  },
};

const ONBOARDING_V2_WITH_PREFERENCES = {
  id: 'onboarding-wizard',
  initial: 'intro',
  context: ONBOARDING_V1.context,
  states: {
    intro: { on: { START: 'profile' } },
    profile: {
      initial: 'basics',
      states: {
        basics: { on: { SAVE_BASICS: 'avatar' } },
        avatar: { on: { UPLOAD_AVATAR: 'preferences', SKIP_AVATAR: 'preferences' } },
        preferences: { on: { SAVE_PREFERENCES: '#onboarding-wizard.review' } },
      },
    },
    review: { on: { SUBMIT: 'submitted' } },
    submitted: { type: 'final' },
  },
};

const SUPPORT_V1 = {
  id: 'support-form',
  initial: 'draft',
  context: {
    issue: { title: null },
    channel: null,
    audit: {},
  },
  states: {
    draft: { on: { START_REQUEST: 'details' } },
    details: { on: { ADD_ATTACHMENT: 'attachments', SUBMIT: 'submitted' } },
    attachments: { on: { SUBMIT: 'submitted' } },
    submitted: { type: 'final' },
  },
};

const SUPPORT_BROKEN_V2 = {
  id: 'support-form',
  initial: 'draft',
  context: SUPPORT_V1.context,
  states: {
    draft: { on: { START_REQUEST: 'describe' } },
    describe: { on: { PICK_CATEGORY: 'category' } },
    category: { on: { SUBMIT: 'submitted' } },
    submitted: { type: 'final' },
  },
};

const SUPPORT_FIXED_V2 = {
  id: 'support-form',
  initial: 'draft',
  context: SUPPORT_V1.context,
  states: {
    draft: { on: { START_REQUEST: 'details_review' } },
    details_review: { on: { PICK_CATEGORY: 'category' } },
    category: { on: { ADD_ATTACHMENT: 'attachments', SUBMIT: 'submitted' } },
    attachments: { on: { SUBMIT: 'submitted' } },
    submitted: { type: 'final' },
  },
};

const SETUP_V1 = {
  id: 'workspace-setup',
  initial: 'setup',
  states: {
    setup: {
      type: 'parallel',
      on: { FINISH: 'complete' },
      states: {
        account: {
          initial: 'email',
          states: {
            email: { on: { ENTER_EMAIL: 'verified' } },
            verified: {},
          },
        },
        workspace: {
          initial: 'name',
          states: {
            name: { on: { NAME_WORKSPACE: 'named' } },
            named: {},
          },
        },
        tour: {
          initial: 'pending',
          states: {
            pending: { on: { WATCH_TOUR: 'watched' } },
            watched: {},
          },
        },
      },
    },
    complete: { type: 'final' },
  },
};

const SETUP_BROKEN_V2 = {
  id: 'workspace-setup',
  initial: 'configure',
  states: {
    configure: {
      type: 'parallel',
      on: { FINISH: 'complete' },
      states: SETUP_V1.states.setup.states,
    },
    complete: { type: 'final' },
  },
};

const SETUP_FIXED_V2 = {
  id: 'workspace-setup',
  initial: 'setup',
  states: {
    setup: {
      type: 'parallel',
      on: { FINISH: 'complete' },
      states: {
        account: SETUP_V1.states.setup.states.account,
        workspace: {
          initial: 'name',
          states: {
            name: { on: { NAME_WORKSPACE: 'named' } },
            named: { on: { CHOOSE_TEMPLATE: 'template_selected' } },
            template_selected: {},
          },
        },
        tour: SETUP_V1.states.setup.states.tour,
      },
    },
    complete: { type: 'final' },
  },
};

describe('SC15-A: simple XState onboarding migration', () => {
  test('wizard keeps its nested step when v2 inserts a preferences step', async () => {
    await withWorker(async (worker) => {
      const actorId = 'onboarding-add-preferences';
      const initialContext = {
        profile: { name: 'Mina', avatarId: null },
        preferences: {},
        audit: {},
      };

      await worker.send({
        type: 'SPAWN',
        actorId,
        definitionId: 'onboarding-v1',
        definitionJson: ONBOARDING_V1,
        initialContext,
      });

      const started = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'START' },
        historyFingerprint: '0',
      });
      const basicsSaved = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'SAVE_BASICS' },
        historyFingerprint: started.historyFingerprint,
      });
      assert.deepEqual(basicsSaved.stateValue, { profile: 'avatar' });

      const migrated = await worker.send({
        type: 'HYDRATE',
        actorId,
        targetDefinitionId: 'onboarding-v2-preferences',
        targetDefinitionJson: ONBOARDING_V2_WITH_PREFERENCES,
        oldContext: basicsSaved.context,
        currentStateValue: basicsSaved.stateValue,
        contextTransform: { 'audit.originalName': 'profile.name' },
        existingFingerprint: basicsSaved.historyFingerprint,
      });
      assert.deepEqual(migrated.stateValue, { profile: 'avatar' });
      assert.equal(migrated.context.audit.originalName, 'Mina');
      assert.equal(migrated.historyFingerprint, computeHistoryHash(['START', 'SAVE_BASICS']));

      const avatar = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'UPLOAD_AVATAR' },
        historyFingerprint: migrated.historyFingerprint,
      });
      assert.deepEqual(avatar.stateValue, { profile: 'preferences' });

      const preferences = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'SAVE_PREFERENCES' },
        historyFingerprint: avatar.historyFingerprint,
      });
      assert.equal(preferences.stateValue, 'review');
    });
  });
});

describe('SC15-B: broken support form then corrected rescue version', () => {
  test('actor in old details state fails on a bad rename and then maps to details_review', async () => {
    await withWorker(async (worker) => {
      const actorId = 'support-bad-rename-then-rescue';
      const initialContext = {
        issue: { title: 'Cannot upload profile image' },
        channel: 'in-app',
        audit: {},
      };

      await worker.send({
        type: 'SPAWN',
        actorId,
        definitionId: 'support-v1',
        definitionJson: SUPPORT_V1,
        initialContext,
      });

      const details = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'START_REQUEST' },
        historyFingerprint: '0',
      });
      assert.equal(details.stateValue, 'details');

      const broken = await worker.send({
        type: 'HYDRATE',
        actorId,
        targetDefinitionId: 'support-broken-v2',
        targetDefinitionJson: SUPPORT_BROKEN_V2,
        oldContext: details.context,
        currentStateValue: details.stateValue,
        existingFingerprint: details.historyFingerprint,
      });
      assert.equal(broken.error, 'STATE_NOT_MAPPABLE');
      assert.equal(broken.currentStateValue, 'details');

      const rescued = await worker.send({
        type: 'HYDRATE',
        actorId,
        targetDefinitionId: 'support-fixed-v2',
        targetDefinitionJson: SUPPORT_FIXED_V2,
        oldContext: details.context,
        currentStateValue: details.stateValue,
        stateMapping: { details: 'details_review' },
        contextTransform: {
          'audit.originalTitle': 'issue.title',
          'audit.originalChannel': 'channel',
        },
        existingFingerprint: details.historyFingerprint,
      });
      assert.equal(rescued.stateValue, 'details_review');
      assert.equal(rescued.context.audit.originalTitle, 'Cannot upload profile image');
      assert.equal(rescued.context.audit.originalChannel, 'in-app');

      const categorized = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'PICK_CATEGORY' },
        historyFingerprint: rescued.historyFingerprint,
      });
      assert.equal(categorized.stateValue, 'category');
    });
  });
});

describe('SC15-C: parallel XState setup flow', () => {
  test('independent UI regions survive migration and only changed regions update fingerprints', async () => {
    await withWorker(async (worker) => {
      const actorId = 'workspace-setup-parallel-rescue';

      const spawned = await worker.send({
        type: 'SPAWN',
        actorId,
        definitionId: 'setup-v1',
        definitionJson: SETUP_V1,
      });
      assert.deepEqual(spawned.stateValue, {
        setup: { account: 'email', workspace: 'name', tour: 'pending' },
      });
      assert.deepEqual(spawned.regionFingerprints, {
        'setup.account': '0',
        'setup.tour': '0',
        'setup.workspace': '0',
      });

      let fp = '0';
      let rfp = spawned.regionFingerprints;

      const email = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'ENTER_EMAIL' },
        historyFingerprint: fp,
        regionFingerprints: rfp,
      });
      fp = email.historyFingerprint;
      rfp = email.regionFingerprints;
      assert.equal(rfp['setup.account'], computeHistoryHash(['ENTER_EMAIL']));
      assert.equal(rfp['setup.workspace'], '0');
      assert.equal(rfp['setup.tour'], '0');

      const named = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'NAME_WORKSPACE' },
        historyFingerprint: fp,
        regionFingerprints: rfp,
      });
      fp = named.historyFingerprint;
      rfp = named.regionFingerprints;
      assert.deepEqual(named.stateValue, {
        setup: { account: 'verified', workspace: 'named', tour: 'pending' },
      });
      assert.equal(rfp['setup.account'], computeHistoryHash(['ENTER_EMAIL']));
      assert.equal(rfp['setup.workspace'], computeHistoryHash(['NAME_WORKSPACE']));
      assert.equal(rfp['setup.tour'], '0');

      const broken = await worker.send({
        type: 'HYDRATE',
        actorId,
        targetDefinitionId: 'setup-broken-v2',
        targetDefinitionJson: SETUP_BROKEN_V2,
        oldContext: named.context,
        currentStateValue: named.stateValue,
        existingFingerprint: fp,
        existingRegionFingerprints: rfp,
      });
      assert.equal(broken.error, 'STATE_NOT_MAPPABLE');

      const fixed = await worker.send({
        type: 'HYDRATE',
        actorId,
        targetDefinitionId: 'setup-fixed-v2',
        targetDefinitionJson: SETUP_FIXED_V2,
        oldContext: named.context,
        currentStateValue: named.stateValue,
        existingFingerprint: fp,
        existingRegionFingerprints: rfp,
      });
      assert.deepEqual(fixed.stateValue, named.stateValue);
      assert.deepEqual(fixed.regionFingerprints, rfp);

      const templated = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'CHOOSE_TEMPLATE' },
        historyFingerprint: fixed.historyFingerprint,
        regionFingerprints: fixed.regionFingerprints,
      });
      assert.deepEqual(templated.stateValue, {
        setup: { account: 'verified', workspace: 'template_selected', tour: 'pending' },
      });
      assert.equal(templated.regionFingerprints['setup.account'], rfp['setup.account']);
      assert.equal(templated.regionFingerprints['setup.tour'], '0');
      assert.equal(templated.regionFingerprints['setup.workspace'], computeHistoryHash(['NAME_WORKSPACE', 'CHOOSE_TEMPLATE']));

      const complete = await worker.send({
        type: 'EVENT',
        actorId,
        event: { type: 'FINISH' },
        historyFingerprint: templated.historyFingerprint,
        regionFingerprints: templated.regionFingerprints,
      });
      assert.equal(complete.stateValue, 'complete');
      assert.equal(complete.regionFingerprints, null);
    });
  });
});

describe('SC15-D: UI-section selector semantics', () => {
  test('selector for completed account section matches actors with extra completed sections', () => {
    const accountAndWorkspaceDone = actorSet({
      'setup.account': computeHistoryHash(['ENTER_EMAIL']),
      'setup.workspace': computeHistoryHash(['NAME_WORKSPACE']),
      'setup.tour': '0',
    });
    const accountOnlyDone = actorSet({
      'setup.account': computeHistoryHash(['ENTER_EMAIL']),
      'setup.workspace': '0',
      'setup.tour': '0',
    });
    const workspaceOnlyDone = actorSet({
      'setup.account': '0',
      'setup.workspace': computeHistoryHash(['NAME_WORKSPACE']),
      'setup.tour': '0',
    });

    const accountSelector = selectorSet({ 'setup.account': ['ENTER_EMAIL'] });
    assert.equal(isSubset(accountSelector, accountAndWorkspaceDone), true);
    assert.equal(isSubset(accountSelector, accountOnlyDone), true);
    assert.equal(isSubset(accountSelector, workspaceOnlyDone), false);

    const accountAndWorkspaceSelector = selectorSet({
      'setup.account': ['ENTER_EMAIL'],
      'setup.workspace': ['NAME_WORKSPACE'],
    });
    assert.equal(isSubset(accountAndWorkspaceSelector, accountAndWorkspaceDone), true);
    assert.equal(isSubset(accountAndWorkspaceSelector, accountOnlyDone), false);
    assert.equal(isSubset(accountAndWorkspaceSelector, workspaceOnlyDone), false);
  });

  test('same event name in two UI regions does not collide because the path is keyed', () => {
    const accountDone = actorSet({ 'setup.account': computeHistoryHash(['DONE']) });
    const workspaceDoneSelector = selectorSet({ 'setup.workspace': ['DONE'] });
    const accountDoneSelector = selectorSet({ 'setup.account': ['DONE'] });

    assert.equal(isSubset(workspaceDoneSelector, accountDone), false);
    assert.equal(isSubset(accountDoneSelector, accountDone), true);
  });
});
