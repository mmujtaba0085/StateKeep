// test/statechart/machineRuntime.spec.js
// Pure-JS — no SQLite: node --test test/statechart/machineRuntime.spec.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { compileMachine }                    = await import('../../src/runtime/definitionCompiler.js');
const { processEvent, computeInitialSnapshot } = await import('../../src/runtime/interpreter.js');

const emptyRegistry = { guards: {}, actions: {}, services: {} };

// ── computeInitialSnapshot ─────────────────────────────────────────────────────
test('computeInitialSnapshot is exported from interpreter.js', () => {
  assert.equal(typeof computeInitialSnapshot, 'function');
});

test('computeInitialSnapshot: flat initial state', () => {
  const def = {
    initial: 'idle',
    states: { idle: { on: { GO: 'running' } }, running: {} },
  };
  const compiled = compileMachine(def);
  const snap = computeInitialSnapshot(compiled, def, { count: 0 }, emptyRegistry);

  assert.equal(snap.error, undefined);
  assert.equal(snap.stateValue, 'idle');
  assert.deepEqual(snap.context, { count: 0 });
  assert.equal(snap.historyFingerprint, '0');
  assert.ok(typeof snap.stateEntryId === 'number');
  assert.equal(snap.done, false);
  assert.ok(Array.isArray(snap.tier2Actions));
  assert.ok(Array.isArray(snap.durableActions));
  assert.ok(Array.isArray(snap.scheduledEventOps));
});

test('computeInitialSnapshot: tier-1 entry actions fire and update context', () => {
  const registry = {
    guards: {},
    actions: { markReady: () => ({ ready: true }) },
    services: {},
  };
  const def = {
    initial: 'idle',
    states: { idle: { entry: ['markReady'], on: { GO: 'done' } }, done: { type: 'final' } },
  };
  const compiled = compileMachine(def);
  const snap = computeInitialSnapshot(compiled, def, {}, registry);

  assert.equal(snap.error, undefined);
  assert.equal(snap.stateValue, 'idle');
  assert.equal(snap.context.ready, true, 'tier-1 entry action must fire synchronously');
});

test('computeInitialSnapshot: transient always-chain fires from initial', () => {
  const def = {
    initial: 'start',
    states: {
      start: { always: [{ target: 'active' }] },
      active: {},
    },
  };
  const compiled = compileMachine(def);
  const snap = computeInitialSnapshot(compiled, def, {}, emptyRegistry);

  assert.equal(snap.error, undefined);
  assert.equal(snap.stateValue, 'active', 'must follow always-transition from initial state');
});

test('computeInitialSnapshot: final initial state sets done=true', () => {
  const def = {
    initial: 'done',
    states: { done: { type: 'final' } },
  };
  const compiled = compileMachine(def);
  const snap = computeInitialSnapshot(compiled, def, {}, emptyRegistry);

  assert.equal(snap.error, undefined);
  assert.equal(snap.done, true);
});

test('computeInitialSnapshot: historyFingerprint is always "0"', () => {
  const def = {
    initial: 'idle',
    states: { idle: {} },
  };
  const compiled = compileMachine(def);
  const snap = computeInitialSnapshot(compiled, def, {}, emptyRegistry);
  assert.equal(snap.historyFingerprint, '0');
});

// ── Full parallel dispatch ─────────────────────────────────────────────────────
test('processEvent: ALL regions of parallel state transition independently', () => {
  const def = {
    initial: 'root',
    states: {
      root: {
        type: 'parallel',
        states: {
          A: { initial: 'a1', states: { a1: { on: { GO: 'a2' } }, a2: {} } },
          B: { initial: 'b1', states: { b1: { on: { GO: 'b2' } }, b2: {} } },
        },
      },
    },
  };
  const compiled = compileMachine(def);
  const entry = {
    actorId: 'test-parallel',
    stateValue: { root: { A: 'a1', B: 'b1' } },
    context: {},
    historyFingerprint: '0',
    stateEntryId: 1,
    regionFingerprints: { 'root.A': '0', 'root.B': '0' },
  };

  const result = processEvent(entry, compiled, { type: 'GO' }, emptyRegistry, []);

  assert.deepEqual(result.stateValue, { root: { A: 'a2', B: 'b2' } },
    'BOTH regions must have transitioned — only region A transitioning is the bug being fixed');
});

test('processEvent: parallel region in final state stays put, other region transitions', () => {
  const def = {
    initial: 'root',
    states: {
      root: {
        type: 'parallel',
        states: {
          A: { initial: 'done', states: { done: { type: 'final' } } },
          B: { initial: 'b1', states: { b1: { on: { GO: 'b2' } }, b2: {} } },
        },
      },
    },
  };
  const compiled = compileMachine(def);
  const entry = {
    actorId: 'test-partial',
    stateValue: { root: { A: 'done', B: 'b1' } },
    context: {},
    historyFingerprint: '0',
    stateEntryId: 1,
    regionFingerprints: { 'root.A': '0', 'root.B': '0' },
  };

  const result = processEvent(entry, compiled, { type: 'GO' }, emptyRegistry, []);

  assert.deepEqual(result.stateValue, { root: { A: 'done', B: 'b2' } },
    'final region A stays put; active region B transitions');
});

test('processEvent: parallel isDone when all regions reach final states', () => {
  const def = {
    initial: 'root',
    states: {
      root: {
        type: 'parallel',
        states: {
          A: { initial: 'a1', states: { a1: { on: { FINISH: 'done' } }, done: { type: 'final' } } },
          B: { initial: 'b1', states: { b1: { on: { FINISH: 'done' } }, done: { type: 'final' } } },
        },
      },
    },
  };
  const compiled = compileMachine(def);
  const entry = {
    actorId: 'test-done',
    stateValue: { root: { A: 'a1', B: 'b1' } },
    context: {},
    historyFingerprint: '0',
    stateEntryId: 1,
    regionFingerprints: { 'root.A': '0', 'root.B': '0' },
  };

  const result = processEvent(entry, compiled, { type: 'FINISH' }, emptyRegistry, []);

  assert.deepEqual(result.stateValue, { root: { A: 'done', B: 'done' } });
  assert.equal(result.done, true, 'done must be true when all regions are in final states');
});

test('processEvent: parallel — event with no matching transition in any region is a no-op', () => {
  const def = {
    initial: 'root',
    states: {
      root: {
        type: 'parallel',
        states: {
          A: { initial: 'a1', states: { a1: { on: { GO: 'a2' } }, a2: {} } },
          B: { initial: 'b1', states: { b1: { on: { GO: 'b2' } }, b2: {} } },
        },
      },
    },
  };
  const compiled = compileMachine(def);
  const entry = {
    actorId: 'test-noop',
    stateValue: { root: { A: 'a1', B: 'b1' } },
    context: {},
    historyFingerprint: '0',
    stateEntryId: 1,
    regionFingerprints: { 'root.A': '0', 'root.B': '0' },
  };

  const result = processEvent(entry, compiled, { type: 'UNKNOWN_EVENT' }, emptyRegistry, []);

  assert.deepEqual(result.stateValue, { root: { A: 'a1', B: 'b1' } }, 'no-op: stateValue unchanged');
  assert.equal(result.done, false);
});

// ── machineRuntime facade (Tasks 3+) ──────────────────────────────────────────
// These tests are added by Task 3; run them after machineRuntime.js is created.
try {
  const { restoreSnapshot, runScenario } = await import('../../src/runtime/machineRuntime.js');

  test('restoreSnapshot: valid landing state returns { stateValue, context }', () => {
    const def = {
      initial: 'idle',
      states: { idle: { on: { GO: 'running' } }, running: {} },
    };
    const compiled = compileMachine(def);
    const result   = restoreSnapshot(compiled, 'running', { count: 5 });

    assert.equal(result.error, undefined);
    assert.equal(result.stateValue, 'running');
    assert.deepEqual(result.context, { count: 5 });
  });

  test('restoreSnapshot: does NOT run entry actions (restore semantics)', () => {
    let entryFired = false;
    const def = {
      initial: 'idle',
      states: { idle: {}, running: { entry: ['markEntry'] } },
    };
    const compiled = compileMachine(def);
    const result = restoreSnapshot(compiled, 'running', {});
    assert.equal(result.error, undefined);
    assert.equal(entryFired, false, 'restoreSnapshot must NOT fire entry actions');
  });

  test('restoreSnapshot: unknown landing state returns { error }', () => {
    const def = {
      initial: 'idle',
      states: { idle: { on: { GO: 'running' } }, running: {} },
    };
    const compiled = compileMachine(def);
    const result   = restoreSnapshot(compiled, 'nonexistent', {});
    assert.ok(result.error, 'must return error for unknown state');
  });

  test('runScenario: executes event sequence and returns steps', () => {
    const def = {
      initial: 'idle',
      states: {
        idle:    { on: { START: 'running' } },
        running: { on: { STOP: 'idle' } },
      },
    };
    const compiled = compileMachine(def);
    const result   = runScenario(compiled, def, {
      name: 'basic',
      events: ['START', 'STOP'],
      expectedStates: ['running', 'idle'],
    });

    assert.equal(result.name, 'basic');
    assert.equal(result.passed, true);
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0].state, 'running');
    assert.equal(result.steps[1].state, 'idle');
    assert.equal(result.done, false);
  });

  test('runScenario: fails when expectedState does not match', () => {
    const def = {
      initial: 'idle',
      states: { idle: { on: { GO: 'running' } }, running: {} },
    };
    const compiled = compileMachine(def);
    const result   = runScenario(compiled, def, {
      events: ['GO'],
      expectedStates: ['WRONG'],
    });

    assert.equal(result.passed, false);
  });

} catch (err) {
  // machineRuntime.js does not exist yet — Task 3 will create it
  // Tests in the try block will be skipped until then
}
