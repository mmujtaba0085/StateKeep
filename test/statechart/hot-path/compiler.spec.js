import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compileMachine } from '../../../src/runtime/definitionCompiler.js';

describe('compileMachine: simple transitions', () => {
  test('flat on: transition produces transition table entry', () => {
    const { transitions } = compileMachine({
      id: 'test', initial: 'idle',
      states: {
        idle: { on: { SUBMIT: 'review' } },
        review: {},
      }
    });
    assert.ok(transitions['idle:SUBMIT'], 'transition entry should exist');
    assert.equal(transitions['idle:SUBMIT'][0].target, 'review');
    assert.equal(transitions['idle:SUBMIT'][0].guard, null);
    assert.deepEqual(transitions['idle:SUBMIT'][0].actions, []);
  });

  test('guarded transition preserves guard name', () => {
    const { transitions } = compileMachine({
      id: 'test', initial: 'idle',
      states: {
        idle: { on: { GO: { target: 'done', guard: 'isReady' } } },
        done: {},
      }
    });
    assert.equal(transitions['idle:GO'][0].guard, 'isReady');
  });

  test('multiple guarded candidates in order', () => {
    const { transitions } = compileMachine({
      id: 'test', initial: 'a',
      states: {
        a: { on: { CHECK: [
          { target: 'b', guard: 'isHigh' },
          { target: 'c', guard: null },
        ]}},
        b: {}, c: {},
      }
    });
    assert.equal(transitions['a:CHECK'].length, 2);
    assert.equal(transitions['a:CHECK'][0].guard, 'isHigh');
    assert.equal(transitions['a:CHECK'][1].guard, null);
  });

  test('final states detected', () => {
    const { finalStates } = compileMachine({
      id: 'test', initial: 'idle',
      states: { idle: {}, done: { type: 'final' } }
    });
    assert.ok(finalStates.includes('done'));
    assert.ok(!finalStates.includes('idle'));
  });
});

describe('compileMachine: after: transformation', () => {
  test('after: is stripped from runtimeDef and injected as on:', () => {
    const { afterTransitions, runtimeDef, transitions } = compileMachine({
      id: 'test', initial: 'waiting',
      states: {
        waiting: { after: [{ delay: 5000, target: 'timed_out' }] },
        timed_out: {},
      }
    });
    assert.ok(afterTransitions['waiting']);
    assert.equal(afterTransitions['waiting'][0].delayMs, 5000);
    const eventType = '__SK_TIMEOUT_waiting_5000';
    assert.equal(afterTransitions['waiting'][0].eventType, eventType);
    assert.equal(runtimeDef.states.waiting.after, undefined, 'after: should be removed');
    assert.ok(runtimeDef.states.waiting.on?.[eventType], 'on: handler should be injected');
    assert.ok(transitions[`waiting:${eventType}`]);
  });
});

describe('compileMachine: entry/exit actions', () => {
  test('entry actions collected per state', () => {
    const { entryActions } = compileMachine({
      id: 'test', initial: 'idle',
      states: {
        idle: {},
        done: { entry: ['logDone', 'notify'] },
      }
    });
    assert.deepEqual(entryActions['done'], ['logDone', 'notify']);
  });

  test('exit actions collected per state', () => {
    const { exitActions } = compileMachine({
      id: 'test', initial: 'idle',
      states: {
        idle: { exit: 'logExit' },
        done: {},
      }
    });
    assert.deepEqual(exitActions['idle'], ['logExit']);
  });
});

describe('compileMachine: always (transient) states', () => {
  test('always transitions recorded in transientStates', () => {
    const { transientStates } = compileMachine({
      id: 'test', initial: 'check',
      states: {
        check: { always: [{ target: 'valid', guard: 'isOk' }, { target: 'invalid' }] },
        valid: {}, invalid: {},
      }
    });
    assert.ok(transientStates['check']);
    assert.equal(transientStates['check'][0].target, 'valid');
    assert.equal(transientStates['check'][0].guard, 'isOk');
    assert.equal(transientStates['check'][1].guard, null);
  });
});
