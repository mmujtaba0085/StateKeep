import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compileMachine } from '../../../src/runtime/definitionCompiler.js';
import { loadRegistry }   from '../../../src/runtime/implementationRegistry.js';
import { processEvent }   from '../../../src/runtime/interpreter.js';

function makeEntry(stateValue, context = {}) {
  return { stateValue, context, historyFingerprint: '0', stateEntryId: 0 };
}

function compiled(def) {
  const { runtimeDef: _, ...c } = compileMachine(def);
  return c;
}

const emptyReg = loadRegistry({});

describe('basic transitions', () => {
  test('fires simple transition', () => {
    const c = compiled({ id: 't', initial: 'idle', states: { idle: { on: { GO: 'done' } }, done: { type: 'final' } } });
    const result = processEvent(makeEntry('idle'), c, { type: 'GO' }, emptyReg);
    assert.equal(result.stateValue, 'done');
    assert.equal(result.done, true);
  });

  test('unknown event is silently ignored', () => {
    const c = compiled({ id: 't', initial: 'idle', states: { idle: { on: { GO: 'done' } }, done: {} } });
    const result = processEvent(makeEntry('idle'), c, { type: 'UNKNOWN' }, emptyReg);
    assert.equal(result.stateValue, 'idle');
  });

  test('updates historyFingerprint on transition', () => {
    const c = compiled({ id: 't', initial: 'idle', states: { idle: { on: { GO: 'done' } }, done: {} } });
    const result = processEvent(makeEntry('idle'), c, { type: 'GO' }, emptyReg);
    assert.notEqual(result.historyFingerprint, '0');
  });

  test('generates new stateEntryId on state change', () => {
    const c = compiled({ id: 't', initial: 'idle', states: { idle: { on: { GO: 'done' } }, done: {} } });
    const result = processEvent(makeEntry('idle'), c, { type: 'GO' }, emptyReg);
    assert.ok(Number.isInteger(result.stateEntryId));
  });
});

describe('guards', () => {
  test('picks first passing candidate', () => {
    const c = compiled({ id: 't', initial: 'a', states: {
      a: { on: { CHECK: [{ target: 'b', guard: 'isHigh' }, { target: 'c' }] } },
      b: {}, c: {},
    }});
    const reg = loadRegistry({ guards: { isHigh: ({ context }) => context.score >= 700 } });

    const high = processEvent(makeEntry('a', { score: 800 }), c, { type: 'CHECK' }, reg);
    assert.equal(high.stateValue, 'b');

    const low = processEvent(makeEntry('a', { score: 500 }), c, { type: 'CHECK' }, reg);
    assert.equal(low.stateValue, 'c');
  });

  test('guard throw is treated as false', () => {
    const c = compiled({ id: 't', initial: 'a', states: {
      a: { on: { EV: [{ target: 'b', guard: 'throws' }, { target: 'c' }] } },
      b: {}, c: {},
    }});
    const reg = loadRegistry({ guards: { throws: () => { throw new Error('oops'); } } });
    const result = processEvent(makeEntry('a'), c, { type: 'EV' }, reg);
    assert.equal(result.stateValue, 'c');
  });
});

describe('always (transient) transitions', () => {
  test('fires immediately after state entry', () => {
    const c = compiled({ id: 't', initial: 'check', states: {
      check: { always: [{ target: 'valid', guard: 'isOk' }, { target: 'invalid' }] },
      valid: {}, invalid: {},
    }});
    // Arriving at 'check' via a transition triggers always
    const c2 = compiled({ id: 't', initial: 'start', states: {
      start: { on: { GO: 'check' } },
      check: { always: [{ target: 'valid', guard: 'isOk' }, { target: 'invalid' }] },
      valid: {}, invalid: {},
    }});
    const reg = loadRegistry({ guards: { isOk: ({ context }) => context.ok } });
    const r1 = processEvent(makeEntry('start', { ok: true }), c2, { type: 'GO' }, reg);
    assert.equal(r1.stateValue, 'valid');
    const r2 = processEvent(makeEntry('start', { ok: false }), c2, { type: 'GO' }, reg);
    assert.equal(r2.stateValue, 'invalid');
  });
});

describe('entry/exit actions returned for async execution', () => {
  test('tier2Actions includes entry actions for new state', () => {
    const c = compiled({ id: 't', initial: 'idle', states: {
      idle: { on: { GO: 'done' } },
      done: { entry: ['notify'] },
    }});
    const reg = loadRegistry({ actions: { notify: async () => {} } });
    const result = processEvent(makeEntry('idle'), c, { type: 'GO' }, reg);
    assert.ok(result.tier2Actions.some(a => a.name === 'notify'));
  });
});

describe('hierarchical state bubbling', () => {
  test('child state bubbles event to parent when not handled locally', () => {
    const c = compiled({ id: 't', initial: 'flow', states: {
      flow: {
        initial: 'step1',
        states: { step1: {}, step2: {} },
        on: { CANCEL: 'cancelled' },
      },
      cancelled: {},
    }});
    const result = processEvent(makeEntry({ flow: 'step1' }), c, { type: 'CANCEL' }, emptyReg);
    assert.equal(result.stateValue, 'cancelled');
  });
});

describe('action execution order', () => {
  test('exit action sees pre-transition context (XState semantics)', () => {
    const c = compiled({ id: 't', initial: 'a', states: {
      a: { exit: 'logCtx', on: { GO: { target: 'b', actions: ['assignX'] } } },
      b: {},
    }});
    const seenCtx = [];
    const reg = loadRegistry({
      actions: {
        logCtx:  ({ context }) => { seenCtx.push(context.x ?? 'none'); },
        assignX: ({ context }) => ({ x: 'assigned' }),
      }
    });
    processEvent(makeEntry('a', {}), c, { type: 'GO' }, reg);
    assert.equal(seenCtx[0], 'none', 'exit action should see pre-transition context');
  });
});

describe('transient loop depth', () => {
  test('100-hop chain completes without error', () => {
    const states = { start: { on: { GO: 's0' } } };
    for (let i = 0; i < 100; i++) {
      states[`s${i}`] = { always: [{ target: `s${i + 1}` }] };
    }
    states['s100'] = { type: 'final' };
    const c = compiled({ id: 't', initial: 'start', states });
    const result = processEvent(makeEntry('start'), c, { type: 'GO' }, emptyReg);
    assert.equal(result.error, undefined, 'should not flag TRANSIENT_LOOP_DETECTED');
    assert.equal(result.stateValue, 's100');
  });
});
