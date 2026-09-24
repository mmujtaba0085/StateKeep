/**
 * POST /v1/definitions/import — convert a Step Functions (ASL), SCXML or BPMN document
 * into a StateKeep definition. Nothing is stored: review the result (and `warnings`),
 * then deploy it with PUT /v1/definitions.
 */
import { importDefinition, detectFormat } from '../../importers/index.js';
import { analyseDefinition } from '../lib/staticAnalysis.js';

export async function importRoutes(fastify) {
  fastify.post('/v1/definitions/import', {
    schema: {
      body: {
        type: 'object', required: ['source'],
        properties: {
          format: { type: 'string', enum: ['asl', 'stepfunctions', 'scxml', 'bpmn'] },
          source: { anyOf: [{ type: 'string', maxLength: 1_000_000 }, { type: 'object' }] },
          id:     { type: 'string', maxLength: 200 },
        },
      },
    },
  }, async (request, reply) => {
    const { source, id } = request.body;
    try {
      const format = request.body.format ?? detectFormat(typeof source === 'string' ? source : JSON.stringify(source));
      const { definition, warnings } = importDefinition(format, source, { id });
      const analysis = analyseDefinition(definition);
      return reply.send({
        format, definition,
        warnings: [...warnings, ...analysis.warnings],
        valid: analysis.errors.length === 0,
        errors: analysis.errors,
      });
    } catch (err) {
      return reply.code(400).send({ error: `import failed: ${err.message}` });
    }
  });
}
