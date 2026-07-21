// Task/ticket lifecycle — 4 states, one retry branch, no parallel regions.
export const def = {
  id: 'task',
  initial: 'open',
  states: {
    open:        { on: { START:   'in_progress' } },
    in_progress: { on: { SUBMIT:  'in_review'   } },
    in_review:   { on: { APPROVE: 'done', REJECT: 'open' } },
    done:        { on: { REOPEN:  'open'         } },
  },
};

// Happy-path cycle — 4 events, loops indefinitely (no final state reached)
export const HAPPY_CYCLE = ['START', 'SUBMIT', 'APPROVE', 'REOPEN'];

// Parallel region paths — none for this machine
export const REGIONS = [];
