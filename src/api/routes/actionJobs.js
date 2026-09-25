/**
 * Review of actions whose outcome is unknown (docs/side-effects.md).
 *
 *   GET  /v1/action-jobs?outcome=unknown     → jobs waiting for a human
 *   POST /v1/action-jobs/:id/resolve         { happened: true,  event?: { type, … } }
 *                                            { happened: false }  → the action runs again
 *
 * `event` (optional, with happened=true) is delivered to the actor exactly once — e.g.
 * the OFFER_SENT the action would have reported had it answered.
 */
import { listActionJobs, getActionJob, resolveActionJob } from '../../registry/actionJobRepo.js';
import { deliverEventOnce } from '../../runtime/deliverOnce.js';
import { clusterEnabled } from '../../cluster/cluster.js';

async function deliver(actorId, event, key) {
  if (!clusterEnabled()) return deliverEventOnce(actorId, event, key);
  const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3001}/v1/internal/actors/${encodeURIComponent(actorId)}/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': process.env.STATEKEEP_ADMIN_KEY ?? '' },
    body: JSON.stringify({ event, idempotencyKey: key }),
  });
  if (!res.ok) throw new Error(`dispatch ${res.status}`);
  return res.json();
}

export async function actionJobRoutes(fastify) {
  fastify.get('/v1/action-jobs', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['unknown', 'resolved-happened', 'succeeded'], default: 'unknown' },
          limit:   { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        },
      },
    },
  }, async (request) => ({ jobs: await listActionJobs(request.query) }));

  fastify.post('/v1/action-jobs/:id/resolve', {
    schema: {
      body: {
        type: 'object', required: ['happened'],
        properties: {
          happened: { type: 'boolean' },
          event:    { type: 'object', required: ['type'], properties: { type: { type: 'string', minLength: 1, pattern: '^(?!__SK_)' } } },
        },
      },
    },
  }, async (request, reply) => {
    const job = await getActionJob(request.params.id);
    if (!job) return reply.code(404).send({ error: 'action job not found' });
    const { happened, event } = request.body;
    if (event && !happened) return reply.code(400).send({ error: 'event is only allowed with happened=true' });
    if (!(await resolveActionJob(job.id, happened))) {
      return reply.code(409).send({ error: `job is not awaiting review (outcome: ${job.outcome ?? 'none'})`, code: 'NOT_UNKNOWN' });
    }
    let delivered = null;
    if (happened && event) delivered = await deliver(job.actorId, event, `resolve:${job.id}`);
    request.log.info({ jobId: job.id, happened }, '[action-jobs] resolved by reviewer');
    return { id: job.id, resolved: happened ? 'happened' : 'will-run-again', eventDelivered: delivered ? !delivered.duplicate : false };
  });
}
