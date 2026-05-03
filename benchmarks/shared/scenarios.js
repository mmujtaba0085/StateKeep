/**
 * benchmarks/shared/scenarios.js
 *
 * Loan-application state machines (v1–v4) and actor group definitions.
 *
 * KEY DESIGN:
 *   Group A (paid fee)   → awaiting_docs  — should migrate to v2 via historyPath
 *   Group B (waived fee) → awaiting_docs  — same state as A, should stay on v1
 *   Group C (fast-track) → fast_track     — state removed by v2, stranded, rescued by v3
 *
 *   v1 → v2: historyPath A — only Group A migrates; Group C is stranded (needs_rescue)
 *   v2 → v3: rescue — historyPath C + stateMapping {fast_track → rescued}
 *   v3 → v4: chain  — historyPath A again, Group A auto-chains v2 → v4 (Approach 6)
 */

// V1 — three paths from info_submitted: PAY_FEE, WAIVE_FEE, FAST_TRACK
export const LOAN_V1 = {
  id:      'loan',
  initial: 'idle',
  states: {
    idle:           { on: { START:       'started'        } },
    started:        { on: { SUBMIT_INFO: 'info_submitted' } },
    info_submitted: { on: { PAY_FEE: 'awaiting_docs', WAIVE_FEE: 'awaiting_docs', FAST_TRACK: 'fast_track' } },
    awaiting_docs:  { on: { UPLOAD_DOCS: 'under_review', SKIP_DOCS: 'under_review' } },
    fast_track:     { on: { APPROVE: 'approved' } },
    under_review:   { on: { APPROVE: 'approved', REJECT: 'rejected' } },
    approved:       { type: 'final' },
    rejected:       { type: 'final' },
  },
};

// V2 — adds income_verify for paid actors; removes fast_track (strands Group C)
export const LOAN_V2 = {
  id:      'loan',
  initial: 'idle',
  states: {
    idle:           { on: { START:          'started'        } },
    started:        { on: { SUBMIT_INFO:    'info_submitted' } },
    info_submitted: { on: { PAY_FEE: 'income_verify', WAIVE_FEE: 'awaiting_docs' } },
    income_verify:  { on: { INCOME_VERIFIED: 'awaiting_docs' } },
    awaiting_docs:  { on: { UPLOAD_DOCS: 'under_review', SKIP_DOCS: 'under_review' } },
    under_review:   { on: { APPROVE: 'approved', REJECT: 'rejected' } },
    approved:       { type: 'final' },
    rejected:       { type: 'final' },
    // fast_track deliberately absent — Group C becomes stranded (needs_rescue)
  },
};

// V3 — rescue for Group C: adds 'rescued' landing state; stateMapping fast_track → rescued
export const LOAN_V3 = {
  id:      'loan',
  initial: 'idle',
  states: {
    idle:           { on: { START:          'started'        } },
    started:        { on: { SUBMIT_INFO:    'info_submitted' } },
    info_submitted: { on: { PAY_FEE: 'income_verify', WAIVE_FEE: 'awaiting_docs' } },
    income_verify:  { on: { INCOME_VERIFIED: 'awaiting_docs' } },
    awaiting_docs:  { on: { UPLOAD_DOCS: 'under_review', SKIP_DOCS: 'under_review' } },
    rescued:        { on: { RESUBMIT: 'awaiting_docs' } },   // landing state for Group C
    under_review:   { on: { APPROVE: 'approved', REJECT: 'rejected' } },
    approved:       { type: 'final' },
    rejected:       { type: 'final' },
  },
};

// V4 — adds expedited_review for Group A; used only by Approach 6 (chained APV)
export const LOAN_V4 = {
  id:      'loan',
  initial: 'idle',
  states: {
    idle:             { on: { START:          'started'        } },
    started:          { on: { SUBMIT_INFO:    'info_submitted' } },
    info_submitted:   { on: { PAY_FEE: 'income_verify', WAIVE_FEE: 'awaiting_docs' } },
    income_verify:    { on: { INCOME_VERIFIED: 'awaiting_docs' } },
    awaiting_docs:    { on: { UPLOAD_DOCS: 'under_review', SKIP_DOCS: 'under_review', EXPEDITE: 'expedited_review' } },
    rescued:          { on: { RESUBMIT: 'awaiting_docs' } },
    expedited_review: { on: { APPROVE: 'approved' } },
    under_review:     { on: { APPROVE: 'approved', REJECT: 'rejected' } },
    approved:         { type: 'final' },
    rejected:         { type: 'final' },
  },
};

// Actor groups — each is 1/3 of ACTOR_COUNT.
export const GROUPS = {
  A: {
    events:      ['START', 'SUBMIT_INFO', 'PAY_FEE'],
    paid:        true,
    group:       'A',
    label:       'paid fee',
    finalState:  'awaiting_docs',
    description: 'Paid fee → awaiting_docs (should migrate to v2)',
  },
  B: {
    events:      ['START', 'SUBMIT_INFO', 'WAIVE_FEE'],
    paid:        false,
    group:       'B',
    label:       'waived fee',
    finalState:  'awaiting_docs',
    description: 'Waived fee → awaiting_docs (same state as A — should stay on v1)',
  },
  C: {
    events:      ['START', 'SUBMIT_INFO', 'FAST_TRACK'],
    paid:        false,
    group:       'C',
    label:       'fast-tracked',
    finalState:  'fast_track',
    description: 'Fast-tracked → fast_track (stranded by v2, rescued to v3 via stateMapping)',
  },
};

// V6 — adds priority_lane for premium Group A actors; used by Approach 10 (4-hop deep chain)
export const LOAN_V6 = {
  id:      'loan',
  initial: 'idle',
  states: {
    idle:              { on: { START:           'started'        } },
    started:           { on: { SUBMIT_INFO:     'info_submitted' } },
    info_submitted:    { on: { PAY_FEE: 'income_verify', WAIVE_FEE: 'awaiting_docs' } },
    income_verify:     { on: { INCOME_VERIFIED: 'awaiting_docs' } },
    awaiting_docs:     { on: { UPLOAD_DOCS: 'under_review', SKIP_DOCS: 'under_review', EXPEDITE: 'expedited_review' } },
    rescued:           { on: { RESUBMIT:        'awaiting_docs' } },
    expedited_review:  { on: { APPROVE: 'approved', PRIORITIZE: 'priority_lane' } },
    priority_lane:     { on: { APPROVE:         'priority_approved' } },
    under_review:      { on: { APPROVE: 'approved', REJECT: 'rejected' } },
    approved:          { type: 'final' },
    priority_approved: { type: 'final' },
    rejected:          { type: 'final' },
  },
};

// Checkout machine with XState parallel states — used by Approach 12
export const CHECKOUT_V1 = {
  id:      'checkout',
  initial: 'active',
  states: {
    active: {
      type: 'parallel',
      states: {
        payment:  { initial: 'unpaid',     states: { unpaid:     { on: { PAY:             'paid'     } }, paid:     {} } },
        shipping: { initial: 'unselected', states: { unselected: { on: { SELECT_SHIPPING: 'selected' } }, selected: {} } },
      },
      on: { SUBMIT: 'submitted' },
    },
    submitted: { type: 'final' },
  },
};

// CHECKOUT_V2 — adds payment verification step; targeted at actors that have paid (historyPath: ['PAY'])
export const CHECKOUT_V2 = {
  id:      'checkout',
  initial: 'active',
  states: {
    active: {
      type: 'parallel',
      states: {
        payment:  { initial: 'unpaid', states: {
          unpaid:   { on: { PAY:            'paid'     } },
          paid:     { on: { VERIFY_PAYMENT: 'verified' } },
          verified: {},
        }},
        shipping: { initial: 'unselected', states: {
          unselected: { on: { SELECT_SHIPPING: 'selected' } },
          selected:   {},
        }},
      },
      on: { SUBMIT: 'submitted' },
    },
    submitted: { type: 'final' },
  },
};

// History paths used by APV engine historyPath deployments
export const PAID_HISTORY_PATH       = ['START', 'SUBMIT_INFO', 'PAY_FEE'];
export const FAST_TRACK_HISTORY_PATH = ['START', 'SUBMIT_INFO', 'FAST_TRACK'];
export const PAY_HISTORY_PATH        = ['PAY'];          // for checkout parallel machine

// StateMapping for rescue deployment
export const RESCUE_STATE_MAPPING = { fast_track: 'rescued' };
