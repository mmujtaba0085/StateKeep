/**
 * src/api/routes/scenarios.js
 *
 * POST /v1/definitions/validate   — Validate a machine definition (syntax + static analysis)
 * POST /v1/definitions/scenario   — Run scenarios against a definition (dry run, no persistence)
 *
 * expectDone semantics (both directions enforced):
 *   expectDone: true  + machine NOT done → fail
 *   expectDone: false + machine IS  done → fail
 */

import { createMachine, createActor } from 'xstate';
import { analyseDefinition } from '../lib/staticAnalysis.js';

function extractGuardNames(obj, guards = new Set()) {
  if (!obj || typeof obj !== 'object') return guards;
  if (Array.isArray(obj)) {
    for (const item of obj) extractGuardNames(item, guards);
  } else {
    if (typeof obj.guard === 'string') guards.add(obj.guard);
    else if (obj.guard && typeof obj.guard === 'object' && typeof obj.guard.type === 'string') {
      guards.add(obj.guard.type);
    }
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') extractGuardNames(val, guards);
    }
  }
  return guards;
}

function buildDefaultGuards(definitionJson) {
  const names = extractGuardNames(definitionJson);
  const guards = {};
  for (const name of names) guards[name] = () => false;
  return guards;
}

function runScenario(definition, scenario) {
  const { name, initialContext = {}, events = [], expectedStates = [], expectDone = false } = scenario;
  const steps = [];
  let passed = true;
  let errorMsg = null;

  try {
    const machine = createMachine(definition).provide({ guards: buildDefaultGuards(definition) });
    const actor   = createActor(machine, { input: initialContext });
    actor.start();

    for (let i = 0; i < events.length; i++) {
      const raw        = events[i];
      const eventType  = typeof raw === 'string' ? raw : raw.type;
      const eventObj   = typeof raw === 'object' ? raw : { type: eventType };
      actor.send(eventObj);
      const snap       = actor.getSnapshot();
      const stateValue = snap.value;
      const expected   = expectedStates[i];
      const stepPassed = expected === undefined || expected === null
        || JSON.stringify(stateValue) === JSON.stringify(expected);
      steps.push({ step: i + 1, event: eventType, state: stateValue, expected: expected ?? '(any)', pass: stepPassed });
      if (!stepPassed) passed = false;
    }

    const finalSnap = actor.getSnapshot();
    const isDone    = finalSnap.status === 'done';

    if (expectDone && !isDone) {
      passed   = false;
      errorMsg = `expectDone:true but actor status is '${finalSnap.status}' (current state: ${JSON.stringify(finalSnap.value)})`;
    } else if (!expectDone && isDone) {
      passed   = false;
      errorMsg = `expectDone:false but actor reached a final state (state: ${JSON.stringify(finalSnap.value)}) — set expectDone:true if intentional`;
    }

    actor.stop();
    return { name, passed, steps, finalState: finalSnap.value, done: isDone, error: errorMsg };
  } catch (err) {
    return { name, passed: false, steps, finalState: null, done: false, error: err.message };
  }
}

export async function scenarioRoutes(fastify) {

  fastify.post('/v1/definitions/validate', {
    schema: { body: { type: 'object', required: ['definition'], properties: { definition: { type: 'object' } } } },
  }, async (request, reply) => {
    const { definition } = request.body;
    const { errors, warnings } = analyseDefinition(definition);

    if (errors.length > 0) {
      return reply.code(400).send({ valid: false, errors, warnings });
    }

    try {
      const machine     = createMachine(definition).provide({ guards: buildDefaultGuards(definition) });
      const actor       = createActor(machine);
      actor.start();
      const snap        = actor.getSnapshot();
      actor.stop();
      const states      = Object.keys(definition.states ?? {});
      const finalStates = states.filter(s => definition.states[s]?.type === 'final');
      return reply.send({ valid: true, initialState: snap.value, stateCount: states.length, states, finalStates, warnings });
    } catch (err) {
      return reply.code(400).send({ valid: false, errors: [{ type: 'XSTATE_ERROR', severity: 'error', message: err.message }], warnings });
    }
  });

  fastify.post('/v1/definitions/scenario', {
    schema: {
      body: {
        type: 'object',
        required: ['definition', 'scenarios'],
        properties: {
          definitionId: { type: 'string' },
          definition:   { type: 'object' },
          scenarios:    { type: 'array', minItems: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { definition, scenarios, definitionId } = request.body;
    const { errors, warnings } = analyseDefinition(definition);
    if (errors.length > 0) {
      return reply.code(400).send({ error: `Invalid machine definition: ${errors[0].message}`, errors, warnings });
    }
    try { createMachine(definition).provide({ guards: buildDefaultGuards(definition) }); } catch (err) {
      return reply.code(400).send({ error: `Invalid machine definition: ${err.message}` });
    }
    const results = scenarios.map(s => runScenario(definition, s));
    const passed  = results.filter(r => r.passed).length;
    const failed  = results.filter(r => !r.passed).length;
    return reply.send({
      definitionId: definitionId ?? null,
      warnings,
      summary: { total: scenarios.length, passed, failed, allPass: failed === 0 },
      results,
    });
  });
}
