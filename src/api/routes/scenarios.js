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

import { runScenario as _runScenario, computeInitialSnapshot } from '../../runtime/machineRuntime.js';
import { analyseDefinition }                                    from '../lib/staticAnalysis.js';

const _emptyRegistry = { guards: {}, actions: {}, services: {} };

/**
 * Wrap machineRuntime.runScenario to enforce expectDone semantics.
 * expectDone is an API-level concern, not a core interpreter concern.
 */
function runScenario(compiledJson, definition, scenario) {
  const { expectDone = false } = scenario;
  const result = _runScenario(compiledJson, definition, scenario);

  if (!result.error) {
    if (expectDone && !result.done) {
      result.passed = false;
      result.error  = `expectDone:true but machine is not done (current state: ${JSON.stringify(result.finalState)})`;
    } else if (!expectDone && result.done) {
      result.passed = false;
      result.error  = `expectDone:false but actor reached a final state (state: ${JSON.stringify(result.finalState)}) — set expectDone:true if intentional`;
    }
  }

  return result;
}

export async function scenarioRoutes(fastify) {

  fastify.post('/v1/definitions/validate', {
    schema: { body: { type: 'object', required: ['definition'], properties: { definition: { type: 'object' } } } },
  }, async (request, reply) => {
    const { definition } = request.body;
    const { errors, warnings, compiledJson } = analyseDefinition(definition);

    if (errors.length > 0) {
      return reply.code(400).send({ valid: false, errors, warnings });
    }

    const states       = Object.keys(definition.states ?? {});
    const finalStates  = states.filter(s => definition.states[s]?.type === 'final');
    const snapResult   = computeInitialSnapshot(compiledJson, definition, {}, _emptyRegistry);
    const initialState = snapResult.error ? null : snapResult.stateValue;

    return reply.send({ valid: true, initialState, stateCount: states.length, states, finalStates, warnings });
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
    const { errors, warnings, compiledJson } = analyseDefinition(definition);

    if (errors.length > 0) {
      return reply.code(400).send({ error: `Invalid machine definition: ${errors[0].message}`, errors, warnings });
    }

    const results = scenarios.map(s => runScenario(compiledJson, definition, s));
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
