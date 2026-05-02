/**
 * test/helpers/factories.js
 *
 * Deterministic and randomised factories for actors, definitions, events,
 * context payloads.  Used across all test levels.
 */

import { randomUUID } from 'crypto';

// ── Machine Definitions ───────────────────────────────────────────────────────

/** Simple linear: idle → processing → done */
export function linearMachine(id = 'linear') {
  return {
    id,
    initial: 'idle',
    states: {
      idle:       { on: { START: 'processing' } },
      processing: { on: { COMPLETE: 'done', FAIL: 'failed' } },
      failed:     { on: { RETRY: 'processing' } },
      done:       { type: 'final' },
    },
  };
}

/** Branching: has guards baked into state names (XState v5 always-true guards) */
export function branchingMachine(id = 'branching') {
  return {
    id,
    initial: 'pending',
    context: { score: 0 },
    states: {
      pending: {
        on: {
          SUBMIT:  { target: 'reviewing' },
          CANCEL:  { target: 'cancelled' },
        },
      },
      reviewing: {
        on: {
          APPROVE: { target: 'approved', actions: [{ type: 'setApproved' }] },
          REJECT:  { target: 'rejected' },
          ESCALATE:{ target: 'escalated' },
        },
      },
      approved:  { type: 'final' },
      rejected:  { on: { RESUBMIT: 'pending' } },
      escalated: { on: { RESOLVE: 'reviewing' } },
      cancelled: { type: 'final' },
    },
  };
}

/** Cyclic machine: supports retries with counter in context */
export function cyclicMachine(id = 'cyclic') {
  return {
    id,
    initial: 'idle',
    context: { retries: 0 },
    states: {
      idle:       { on: { RUN: 'running' } },
      running:    { on: { SUCCESS: 'done', FAIL: 'retry_wait' } },
      retry_wait: { on: { RETRY: 'running', GIVE_UP: 'exhausted' } },
      done:       { type: 'final' },
      exhausted:  { type: 'final' },
    },
  };
}

/** Deeply nested hierarchical machine */
export function hierarchicalMachine(id = 'hierarchical') {
  return {
    id,
    initial: 'off',
    states: {
      off:  { on: { POWER_ON: 'on' } },
      on: {
        initial: 'idle',
        on: { POWER_OFF: 'off' },
        states: {
          idle:    { on: { START: 'active' } },
          active: {
            initial: 'normal',
            on: { PAUSE: 'paused' },
            states: {
              normal:    { on: { BOOST: 'boosted' } },
              boosted:   { on: { THROTTLE: 'normal' } },
            },
          },
          paused: { on: { RESUME: 'active', STOP: 'idle' } },
        },
      },
    },
  };
}

/** Machine with entry/exit actions (action names only — no implementation) */
export function actionMachine(id = 'actions') {
  return {
    id,
    initial: 'ready',
    states: {
      ready: {
        entry: [{ type: 'logEntry' }],
        exit:  [{ type: 'logExit' }],
        on: { ACTIVATE: 'active' },
      },
      active: {
        entry: [{ type: 'startTimer' }],
        exit:  [{ type: 'stopTimer' }],
        on: { DEACTIVATE: 'ready', FINISH: 'done' },
      },
      done: { type: 'final' },
    },
  };
}

/** V2 of the linear machine — adds an 'initializing' state */
export function linearMachineV2(id = 'linear') {
  return {
    id,
    initial: 'idle',
    states: {
      idle:          { on: { START: 'initializing', QUICK_START: 'processing' } },
      initializing:  { on: { READY: 'processing' } },
      processing:    { on: { COMPLETE: 'done', FAIL: 'failed' } },
      failed:        { on: { RETRY: 'processing' } },
      done:          { type: 'final' },
    },
  };
}

/** V3 rescue — adds 'recovering' path from failed */
export function linearMachineV3(id = 'linear') {
  return {
    id,
    initial: 'idle',
    states: {
      idle:       { on: { START: 'processing', QUICK_START: 'processing' } },
      processing: { on: { COMPLETE: 'done', FAIL: 'failed' } },
      failed:     { on: { RETRY: 'processing', RECOVER: 'recovering' } },
      recovering: { on: { DONE: 'done' } },
      done:       { type: 'final' },
    },
  };
}

// ── Context Payloads ──────────────────────────────────────────────────────────

export const contexts = {
  /** Minimal context */
  empty: {},

  /** Typical small payload */
  small: { userId: 'user-123', orderId: 'ord-456', timestamp: Date.now() },

  /** Medium nested object */
  medium: {
    user:  { id: 'usr-789', name: 'Alice', email: 'alice@example.com', roles: ['admin', 'user'] },
    order: { id: 'ord-321', items: [{ sku: 'ITEM-1', qty: 2 }, { sku: 'ITEM-2', qty: 1 }], total: 99.99 },
    meta:  { source: 'web', userAgent: 'Mozilla/5.0', ip: '127.0.0.1' },
  },

  /** Large nested object (~10KB JSON) */
  large: {
    payload: Array.from({ length: 100 }, (_, i) => ({
      id:      `item-${i}`,
      name:    `Item ${i} with a longer description for testing purposes`,
      value:   Math.random() * 1000,
      tags:    [`tag-${i % 5}`, `category-${i % 10}`],
      nested:  { a: i, b: i * 2, c: i * 3 },
    })),
  },

  /** Unicode / emoji payload */
  unicode: {
    greeting: 'こんにちは',
    emoji:    '🎉🚀💡',
    arabic:   'مرحبا',
    mixed:    'Hello Wörld 日本語 🌍',
  },

  /** Null and edge-case values */
  edgeCases: {
    nullValue:    null,
    emptyString:  '',
    zero:         0,
    falsy:        false,
    deepNull:     { a: { b: { c: null } } },
    largeInt:     Number.MAX_SAFE_INTEGER,
  },
};

// ── Event Sequences ───────────────────────────────────────────────────────────

/** Events to take linear machine to done */
export const linearToDone = [
  { type: 'START' },
  { type: 'COMPLETE' },
];

/** Events with retries (cyclic machine) */
export const cyclicWithRetry = [
  { type: 'RUN' },
  { type: 'FAIL' },
  { type: 'RETRY' },
  { type: 'FAIL' },
  { type: 'RETRY' },
  { type: 'SUCCESS' },
];

/** Long event sequence with branching */
export function makeEventSequence(length = 20) {
  const types = ['START', 'PAUSE', 'RESUME', 'RETRY', 'FAIL', 'COMPLETE'];
  return Array.from({ length }, () => ({
    type:    types[Math.floor(Math.random() * types.length)],
    payload: { ts: Date.now(), rand: Math.random() },
  }));
}

// ── Definition ID Generators ──────────────────────────────────────────────────

export function defId(name, version = 1) {
  return `${name}-v${version}-${Date.now()}`;
}

export function uniqueId(prefix = 'test') {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

// ── Logical Time Helpers ──────────────────────────────────────────────────────

/** Simulate actors created at varied logical times */
export const logicalTimes = {
  justNow:   1,
  recentMin: 100,
  recentHr:  3600,
  dayAgo:    86_400,
  weekAgo:   604_800,
  ancient:   1_000_000,
};
