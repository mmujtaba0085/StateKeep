import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { createDefinition, findDefinitionById, updateCompiledJson } from '../../../src/registry/definitionRepo.js';

test('createDefinition stores compiledJson', async () => {
  const id  = randomUUID();
  const compiled = { transitions: { 'idle:GO': [{ target: 'done', guard: null, actions: [] }] }, finalStates: ['done'], afterTransitions: {}, entryActions: {}, exitActions: {}, transientStates: {}, parallelGroups: [] };
  await createDefinition({
    id,
    definitionJson: { id, initial: 'idle', states: { idle: { on: { GO: 'done' } }, done: { type: 'final' } } },
    compiledJson: compiled,
    deployedAt: Date.now(),
  });
  const def = await findDefinitionById(id);
  assert.ok(def.compiledJson, 'compiledJson should be returned');
  assert.ok(def.compiledJson.transitions['idle:GO'], 'transition should survive round-trip');
});

test('updateCompiledJson updates the compiled form', async () => {
  const id = randomUUID();
  await createDefinition({ id, definitionJson: { id, initial: 'a', states: { a: {} } }, deployedAt: Date.now() });
  const compiled = { transitions: {}, finalStates: [], afterTransitions: {}, entryActions: {}, exitActions: {}, transientStates: {}, parallelGroups: [] };
  await updateCompiledJson(id, compiled);
  const def = await findDefinitionById(id);
  assert.deepEqual(def.compiledJson.transitions, {});
});
