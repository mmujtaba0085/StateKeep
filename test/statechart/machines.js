/**
 * test/statechart/machines.js
 *
 * Master catalog of every JSON statechart used in the statechart test suite.
 *
 * Each entry is a plain object — the exact JSON that gets sent to
 * PUT /v1/definitions or POST /v1/definitions/validate.
 *
 * Grouped into:
 *   VALID_*   — well-formed, logically correct
 *   BROKEN_*  — invalid JSON structure (caught at validate/spawn time)
 *   STUCK_*   — structurally valid but logically broken (actor gets stuck)
 *   MIGRATE_* — used in migration tests (v1 + v2 pairs)
 */

// ─────────────────────────────────────────────────────────────────────────────
// VALID MACHINES
// ─────────────────────────────────────────────────────────────────────────────

/** 1. Absolute minimum — two states, one transition */
export const VALID_MINIMAL = {
  id:      'minimal',
  initial: 'off',
  states: {
    off: { on: { TURN_ON: 'on' } },
    on:  { type: 'final' },
  },
};

/** 2. Simple linear pipeline */
export const VALID_LINEAR = {
  id:      'linear',
  initial: 'idle',
  states: {
    idle:       { on: { START: 'processing' } },
    processing: { on: { COMPLETE: 'done', FAIL: 'failed' } },
    failed:     { on: { RETRY: 'processing' } },
    done:       { type: 'final' },
  },
};

/** 3. Branching: multiple exits from reviewing */
export const VALID_BRANCHING = {
  id:      'approval',
  initial: 'draft',
  states: {
    draft:     { on: { SUBMIT: 'pending', DISCARD: 'discarded' } },
    pending:   { on: { APPROVE: 'approved', REJECT: 'rejected', ESCALATE: 'escalated' } },
    escalated: { on: { APPROVE: 'approved', REJECT: 'rejected' } },
    approved:  { type: 'final' },
    rejected:  { on: { REVISE: 'draft' } },
    discarded: { type: 'final' },
  },
};

/** 4. Cyclic: retry loop with counter in context */
export const VALID_CYCLIC = {
  id:      'job',
  initial: 'queued',
  context: { attempts: 0, maxAttempts: 3 },
  states: {
    queued:    { on: { PICK_UP: 'running' } },
    running:   { on: { SUCCESS: 'done', ERROR: 'waiting' } },
    waiting:   { on: { RETRY: 'running', ABORT: 'aborted' } },
    done:      { type: 'final' },
    aborted:   { type: 'final' },
  },
};

/** 5. Hierarchical — nested compound states */
export const VALID_HIERARCHICAL = {
  id:      'device',
  initial: 'off',
  states: {
    off: { on: { POWER: 'on' } },
    on: {
      initial: 'idle',
      on: { POWER: 'off' },
      states: {
        idle:   { on: { WORK: 'working' } },
        working: {
          initial: 'normal',
          on: { IDLE: 'idle' },
          states: {
            normal:  { on: { BOOST: 'boosted' } },
            boosted: { on: { THROTTLE: 'normal' } },
          },
        },
      },
    },
  },
};

/** 6. Parallel (orthogonal regions) */
export const VALID_PARALLEL = {
  id:      'checkout',
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
            paid:   {},
          },
        },
        shipping: {
          initial: 'unselected',
          states: {
            unselected: { on: { SELECT_SHIPPING: 'selected' } },
            selected:   {},
          },
        },
      },
    },
    done: { type: 'final' },
  },
};

/** 7. Entry/exit actions (names only — XState v5 treats unknown actions as no-ops) */
export const VALID_WITH_ACTIONS = {
  id:      'session',
  initial: 'authenticating',
  states: {
    authenticating: {
      entry: [{ type: 'logAttempt' }],
      on: {
        LOGIN_SUCCESS: 'active',
        LOGIN_FAIL:    'failed',
      },
    },
    active: {
      entry: [{ type: 'startSessionTimer' }],
      exit:  [{ type: 'stopSessionTimer' }],
      on: {
        LOGOUT:  'terminated',
        TIMEOUT: 'expired',
      },
    },
    failed:     { on: { RETRY: 'authenticating' } },
    expired:    { on: { LOGIN: 'authenticating' } },
    terminated: { type: 'final' },
  },
};

/** 8. Multiple final states */
export const VALID_MULTI_FINAL = {
  id:      'order',
  initial: 'pending',
  states: {
    pending:   { on: { PAY: 'paid', CANCEL: 'cancelled' } },
    paid:      { on: { SHIP: 'shipped', REFUND: 'refunded' } },
    shipped:   { on: { DELIVER: 'delivered', RETURN: 'returning' } },
    returning: { on: { RECEIVED: 'refunded' } },
    delivered: { type: 'final' },
    refunded:  { type: 'final' },
    cancelled: { type: 'final' },
  },
};

/** 9. Self-transition (stays in same state, re-fires entry actions) */
export const VALID_SELF_TRANSITION = {
  id:      'counter',
  initial: 'counting',
  context: { count: 0 },
  states: {
    counting: {
      on: {
        INCREMENT: 'counting',   // self-loop
        RESET:     'counting',   // self-loop
        FINISH:    'done',
      },
    },
    done: { type: 'final' },
  },
};

/** 10. Deep hierarchy (4 levels) — uses absolute IDs for cross-level transitions */
export const VALID_DEEP = {
  id:      'wizard',
  initial: 'step1',
  states: {
    step1: {
      initial: 'intro',
      states: {
        intro: {
          initial: 'welcome',
          states: {
            welcome:    { on: { NEXT: 'terms' } },
            terms:      { on: { ACCEPT: 'accepted', BACK: 'welcome' } },
            accepted:   { on: { ADVANCE: '#wizard.step2' } },  // absolute ID to exit compound
          },
        },
      },
    },
    step2: { on: { NEXT: 'step3', BACK: 'step1' } },
    step3: { on: { SUBMIT: 'done', BACK: 'step2' } },
    done:  { type: 'final' },
  },
};

/** 11. Many states (20 states — a long pipeline) */
export const VALID_MANY_STATES = (() => {
  const stages = [
    'intake', 'triage', 'assessment', 'planning', 'design',
    'review', 'approval', 'procurement', 'scheduling', 'preparation',
    'execution_a', 'execution_b', 'execution_c', 'testing', 'qa',
    'staging', 'sign_off', 'deployment', 'monitoring', 'done',
  ];
  const states = {};
  for (let i = 0; i < stages.length - 1; i++) {
    states[stages[i]] = { on: { NEXT: stages[i + 1], REJECT: 'intake' } };
  }
  states['done'] = { type: 'final' };
  return { id: 'pipeline', initial: 'intake', states };
})();

/** 12. Onboarding (from examples — realistic SaaS flow) */
export const VALID_ONBOARDING = {
  id:      'onboarding',
  initial: 'email_verification',
  states: {
    email_verification: { on: { EMAIL_VERIFIED: 'profile_setup', SKIP: 'profile_setup' } },
    profile_setup:      { on: { PROFILE_COMPLETE: 'kyc_check', BACK: 'email_verification' } },
    kyc_check:          { on: { KYC_PASSED: 'active', KYC_FAILED: 'suspended' } },
    active:             { on: { SUSPEND: 'suspended', CLOSE: 'closed' } },
    suspended:          { on: { REINSTATE: 'active', CLOSE: 'closed' } },
    closed:             { type: 'final' },
  },
};

/** 13. Context-heavy machine with initial context values */
export const VALID_CONTEXT_HEAVY = {
  id:      'loan',
  initial: 'application',
  context: {
    applicantId:   null,
    amount:        0,
    term:          0,
    creditScore:   0,
    approvedBy:    null,
    rejectionNote: null,
  },
  states: {
    application:  { on: { SUBMIT: 'underwriting', WITHDRAW: 'withdrawn' } },
    underwriting: { on: { PASS: 'approved', FAIL: 'rejected', REFER: 'manual_review' } },
    manual_review:{ on: { APPROVE: 'approved', REJECT: 'rejected' } },
    approved:     { on: { DISBURSE: 'active', CANCEL: 'cancelled' } },
    active:       { on: { REPAY: 'closed', DEFAULT: 'defaulted' } },
    rejected:     { type: 'final' },
    withdrawn:    { type: 'final' },
    cancelled:    { type: 'final' },
    closed:       { type: 'final' },
    defaulted:    { type: 'final' },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION PAIRS  (v1 + v2 / v3)
// ─────────────────────────────────────────────────────────────────────────────

/** Migration pair A — v2 adds a new state (backward-compatible) */
export const MIGRATE_A_V1 = {
  id:      'ticket',
  initial: 'open',
  states: {
    open:   { on: { ASSIGN: 'assigned', CLOSE: 'closed' } },
    assigned: { on: { RESOLVE: 'resolved', UNASSIGN: 'open' } },
    resolved: { type: 'final' },
    closed:   { type: 'final' },
  },
};

export const MIGRATE_A_V2 = {
  id:      'ticket',
  initial: 'open',
  states: {
    open:      { on: { ASSIGN: 'assigned', CLOSE: 'closed', TRIAGE: 'triaged' } },
    triaged:   { on: { ASSIGN: 'assigned', CLOSE: 'closed' } },   // NEW
    assigned:  { on: { RESOLVE: 'resolved', UNASSIGN: 'open', ESCALATE: 'escalated' } },
    escalated: { on: { RESOLVE: 'resolved', DEESCALATE: 'assigned' } },  // NEW
    resolved:  { type: 'final' },
    closed:    { type: 'final' },
  },
};

/** Migration pair B — v2 renames a state (BREAKING) */
export const MIGRATE_B_V1 = {
  id:      'subscription',
  initial: 'trial',
  states: {
    trial:    { on: { CONVERT: 'active', EXPIRE: 'expired' } },
    active:   { on: { CANCEL: 'cancelled', SUSPEND: 'suspended' } },
    suspended:{ on: { RESUME: 'active', CANCEL: 'cancelled' } },
    expired:  { type: 'final' },
    cancelled:{ type: 'final' },
  },
};

export const MIGRATE_B_V2 = {
  id:      'subscription',
  initial: 'trial',
  states: {
    trial:    { on: { CONVERT: 'paying', EXPIRE: 'expired' } },  // 'active' → 'paying' (RENAME)
    paying:   { on: { CANCEL: 'cancelled', PAUSE: 'paused' } },  // 'active' gone, 'paying' added
    paused:   { on: { RESUME: 'paying', CANCEL: 'cancelled' } }, // 'suspended' → 'paused'
    expired:  { type: 'final' },
    cancelled:{ type: 'final' },
  },
};

/** Migration pair C — v2 adds entry actions and removes transitions */
export const MIGRATE_C_V1 = {
  id: 'workflow',
  initial: 'idle',
  states: {
    idle:       { on: { START: 'running', SCHEDULE: 'scheduled' } },
    scheduled:  { on: { TRIGGER: 'running', CANCEL: 'idle' } },
    running:    { on: { DONE: 'complete', FAIL: 'failed' } },
    failed:     { on: { RETRY: 'running', GIVE_UP: 'dead' } },
    complete:   { type: 'final' },
    dead:       { type: 'final' },
  },
};

export const MIGRATE_C_V2 = {
  id: 'workflow',
  initial: 'idle',
  states: {
    idle:       { on: { START: 'running' } },          // SCHEDULE removed
    running:    {
      entry: [{ type: 'notifyStarted' }],
      on: { DONE: 'complete', FAIL: 'failed' },
    },
    failed:     { on: { RETRY: 'running' } },          // GIVE_UP removed
    complete:   { type: 'final' },
  },
  // 'scheduled' and 'dead' removed entirely
};

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURALLY BROKEN MACHINES  (should be rejected)
// ─────────────────────────────────────────────────────────────────────────────

/** B1. Missing `initial` field */
export const BROKEN_NO_INITIAL = {
  id: 'broken-no-initial',
  states: {
    a: { on: { GO: 'b' } },
    b: { type: 'final' },
  },
};

/** B2. `initial` references a non-existent state */
export const BROKEN_INITIAL_MISSING_TARGET = {
  id:      'broken-initial-target',
  initial: 'nonexistent_state',
  states: {
    a: { on: { GO: 'b' } },
    b: { type: 'final' },
  },
};

/** B3. Transition targets a state that doesn't exist */
export const BROKEN_TRANSITION_TO_NOWHERE = {
  id:      'broken-transition-nowhere',
  initial: 'a',
  states: {
    a: { on: { GO: 'b', JUMP: 'ghost_state' } },  // ghost_state doesn't exist
    b: { type: 'final' },
  },
};

/** B4. Empty `states` object
 *  XState v5 behaviour:
 *    createMachine(def)  -> succeeds silently
 *    actor.start()       -> deferred internal throw (async microtask):
 *                          "Initial state node 'a' not found on #broken-empty-states"
 *    actor.getSnapshot() -> value = undefined (before deferred throw surfaces)
 *  Platform gap: validate endpoint's try/catch misses the async throw.
 *  Returns valid:true, initialState:undefined — fix: check snap.value === undefined.
 */
export const BROKEN_EMPTY_STATES = {
  id:      'broken-empty-states',
  initial: 'a',
  states:  {},
};

/** B5. Missing `states` entirely */
export const BROKEN_NO_STATES = {
  id:      'broken-no-states',
  initial: 'a',
};

/** B6. Parallel state with no regions */
export const BROKEN_PARALLEL_NO_CHILDREN = {
  id:      'broken-parallel-empty',
  initial: 'work',
  states: {
    work: { type: 'parallel', states: {} },   // parallel needs child regions
    done: { type: 'final' },
  },
};

/** B7. Compound state missing its own `initial` */
export const BROKEN_COMPOUND_NO_INITIAL = {
  id:      'broken-compound-no-initial',
  initial: 'outer',
  states: {
    outer: {
      // Missing `initial` — XState v5 throws at actor.start()
      states: {
        child_a: { on: { GO: 'child_b' } },
        child_b: {},
      },
    },
  },
};

/** B8. Completely invalid JSON shape (not an object) */
export const BROKEN_NOT_AN_OBJECT = 'I am not a machine definition';

/** B9. `initial` is a number instead of string
 *  NOTE: XState v5 accepts numeric `initial` silently — initial resolves to undefined.
 */
export const BROKEN_INITIAL_WRONG_TYPE = {
  id:      'broken-initial-type',
  initial: 42,
  states: {
    42:   { on: { GO: 'b' } },
    b:    { type: 'final' },
  },
};

/** B10. Transition target is null */
export const BROKEN_NULL_TRANSITION_TARGET = {
  id:      'broken-null-target',
  initial: 'a',
  states: {
    a: { on: { GO: null } },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// LOGICALLY STUCK MACHINES  (valid JSON, accepted by XState, but actor traps)
// ─────────────────────────────────────────────────────────────────────────────

/** S1. Dead-end state — non-final, no outgoing transitions */
export const STUCK_DEAD_END = {
  id:      'stuck-dead-end',
  initial: 'start',
  states: {
    start:   { on: { GO: 'trapped' } },
    trapped: {},  // no transitions, not final — actor stuck forever
    done:    { type: 'final' },
  },
};

/** S2. Unreachable state — no incoming path from initial */
export const STUCK_UNREACHABLE = {
  id:      'stuck-unreachable',
  initial: 'a',
  states: {
    a:           { on: { GO: 'b' } },
    b:           { type: 'final' },
    unreachable: { on: { ESCAPE: 'b' } },  // nothing leads here
  },
};

/** S3. All paths lead to non-final state — machine never terminates */
export const STUCK_NO_TERMINAL = {
  id:      'stuck-no-terminal',
  initial: 'a',
  states: {
    a: { on: { GO: 'b' } },
    b: { on: { BACK: 'a' } },
    // Neither state is final — actors spin forever
  },
};

/** S4. Self-loop only — actor spins but never advances */
export const STUCK_SELF_LOOP_ONLY = {
  id:      'stuck-self-loop',
  initial: 'spinning',
  states: {
    spinning: { on: { SPIN: 'spinning' } },  // spins forever, never exits
    done:     { type: 'final' },             // unreachable
  },
};

/** S5. Missing transition for the event the scenario sends */
export const STUCK_MISSING_EVENT = {
  id:      'stuck-missing-event',
  initial: 'waiting',
  states: {
    waiting: { on: { WAKE: 'done' } },  // only WAKE works, no START
    done:    { type: 'final' },
  },
};

/** S6. Context-dependent path that never satisfies condition
 *  (guards are no-ops in XState v5 without implementation — transitions always fire)
 *  This tests what happens when you reference guard names in v5 without implementations.
 */
export const STUCK_GUARD_NO_IMPL = {
  id:      'stuck-guard-no-impl',
  initial: 'check',
  states: {
    check: {
      on: {
        EVALUATE: [
          { target: 'pass', guard: 'isEligible' },   // no implementation provided
          { target: 'fail' },
        ],
      },
    },
    pass: { type: 'final' },
    fail: { type: 'final' },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// COMPLEX MULTI-ACTOR MACHINE  (for stress + migration tests)
// ─────────────────────────────────────────────────────────────────────────────

/** Full SaaS subscription lifecycle — used for multi-actor + migration tests */
export const COMPLEX_SAAS = {
  id:      'saas_sub',
  initial: 'lead',
  context: {
    plan:          null,
    mrr:           0,
    churnRisk:     'low',
    supportTickets:0,
  },
  states: {
    lead:        { on: { SIGN_UP: 'trial', DISQUALIFY: 'lost' } },
    trial:       { on: { CONVERT: 'active', EXPIRE: 'churned', CANCEL: 'churned' } },
    active: {
      initial: 'healthy',
      on: { CANCEL: 'churned', SUSPEND: 'suspended' },
      states: {
        healthy:    { on: { RISK_DETECTED: 'at_risk' } },
        at_risk:    { on: { RESOLVED: 'healthy', UNRESOLVED: 'churning' } },
        churning:   { on: { SAVE: 'healthy', LOST: 'final_notice' } },
        final_notice: { on: { SAVE: 'healthy' } },
      },
    },
    suspended:   { on: { REINSTATE: 'active', CANCEL: 'churned' } },
    churned:     { type: 'final' },
    lost:        { type: 'final' },
  },
};

export const COMPLEX_SAAS_V2 = {
  id:      'saas_sub',
  initial: 'lead',
  context: {
    plan:           null,
    mrr:            0,
    churnRisk:      'low',
    supportTickets: 0,
    npsScore:       null,  // NEW field in v2
  },
  states: {
    lead:        { on: { SIGN_UP: 'trial', QUALIFY: 'trial', DISQUALIFY: 'lost' } },
    trial: {
      initial: 'free',
      on: { EXPIRE: 'churned', CANCEL: 'churned' },
      states: {
        free:     { on: { UPGRADE: 'extended', CONVERT: 'converting' } },
        extended: { on: { CONVERT: 'converting' } },
        converting: {},
      },
      on: { CONVERT: 'active' },
    },
    active: {
      initial: 'healthy',
      on: { CANCEL: 'churned', SUSPEND: 'suspended', UPGRADE: 'active' },
      states: {
        healthy:      { on: { RISK_DETECTED: 'at_risk' } },
        at_risk:      { on: { RESOLVED: 'healthy', UNRESOLVED: 'churning' } },
        churning:     { on: { SAVE: 'healthy', LOST: 'final_notice' } },
        final_notice: { on: { SAVE: 'healthy' } },
      },
    },
    suspended:   { on: { REINSTATE: 'active', CANCEL: 'churned' } },
    churned:     { type: 'final' },
    lost:        { type: 'final' },
  },
};
