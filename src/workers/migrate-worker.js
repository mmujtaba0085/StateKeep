/**
 * src/workers/migrate-worker.js
 *
 * Background process: processes migration_jobs in batches.
 */

import { getDb, isPostgres } from '../registry/db.js';
import { startHeartbeat } from './heartbeat.js';
import { claimBatch, markDone, markFailed, resetProcessingJobs, releaseJob } from '../registry/jobRepo.js';
import { findActorById } from '../registry/actorRepo.js';
import { incrementMigrated, incrementFailed, updateDeploymentStatus, findDeploymentById } from '../registry/deploymentRepo.js';
import { seedEngineRegistry } from '../runtime/actorManager.js';
import { insertMigrationNotification } from '../registry/migrationNotificationRepo.js';
import { getEngine, engineReady, scopeOf } from '../ffi/engine.js';

const BATCH_SIZE    = 500;
const POLL_INTERVAL = 500;

const API_PORT  = process.env.PORT ?? 3001;
const ADMIN_KEY = process.env.STATEKEEP_ADMIN_KEY ?? '';

console.log('[migrate-worker] Starting...');

await engineReady;

if (isPostgres) {
  const { bootstrapSchema } = await import('../registry/db-postgres.js');
  await bootstrapSchema();
} else {
  getDb();  // bootstrap SQLite
}

startHeartbeat('migrate');
await seedEngineRegistry();

// Reset orphaned processing jobs from crashed runs
await resetProcessingJobs();

// (This process does not route actors: every job is sent to the actor's owning API
//  server, which syncs its own registry first. It therefore keeps no registry copy.)



async function insertDecision(actorId, deploymentId, tick, decision, reason, fromDefId, toDefId, fingerprint) {
  try {
    if (isPostgres) {
      const { query } = await import('../registry/db-postgres.js');
      await query(
        `INSERT INTO migration_decisions (actor_id, deployment_id, trigger, evaluated_at, decision, reason, from_definition_id, to_definition_id, actor_fingerprint, prefix_hash, created_at)
         VALUES ($1,$2,'batch_worker',$3,$4,$5,$6,$7,$8,'0',$9)`,
        [actorId, deploymentId, tick, decision, reason, fromDefId, toDefId, fingerprint, Date.now()]
      );
    } else {
      getDb().prepare(
        `INSERT INTO migration_decisions (actor_id, deployment_id, trigger, evaluated_at, decision, reason, from_definition_id, to_definition_id, actor_fingerprint, prefix_hash, created_at)
         VALUES (?,?,'batch_worker',?,?,?,?,?,?,'0',?)`
      ).run(actorId, deploymentId, tick, decision, reason, fromDefId, toDefId, fingerprint, Date.now());
    }
  } catch (e) {
    console.warn(`[migrate-worker] decision log failed for ${actorId}: ${e.message}`);
  }
}

async function processJob(job) {
  const { id, actor_id, target_def_id, deployment_id } = job;
  const eng = getEngine();
  const currentTick = Number(eng.clockTick());
  const actorBefore = await findActorById(actor_id);
  const fromDefId   = actorBefore?.definitionId ?? null;

  // The server that owns the actor applies the migration, under the actor's lock and
  // against its current state; it also re-checks that the move is still valid.
  let r;
  try {
    const res = await fetch(`${process.env.STATEKEEP_INTERNAL_URL ?? `http://127.0.0.1:${API_PORT}`}/v1/internal/actors/${encodeURIComponent(actor_id)}/migrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ targetDefinitionId: target_def_id, deploymentId: deployment_id }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    r = await res.json();
  } catch (err) {
    // server unreachable (restarting, failing over): try this job again later
    console.warn(`[migrate-worker] Job ${id}: owner unreachable (${err.message}) — will retry`);
    await releaseJob(id);
    return;
  }

  if (r.outcome === 'migrated' || r.outcome === 'already') {
    await markDone(id);
    await incrementMigrated(deployment_id);
    if (r.outcome === 'migrated') {
      await insertMigrationNotification(actor_id, fromDefId, target_def_id).catch(() => {});
      await insertDecision(actor_id, deployment_id, currentTick, 'migrated', 'batch', fromDefId, target_def_id, actorBefore?.historyFingerprint ?? '0');
    }
  } else if (r.outcome === 'needs_rescue') {
    console.warn(`[migrate-worker] Job ${id}: actor ${actor_id} needs_rescue — ${r.reason}`);
    await markFailed(id, `${r.reason}: ${JSON.stringify(r.stateValue)}`);
    await incrementFailed(deployment_id);
  } else {
    await markFailed(id, `cancelled: ${r.reason}`);
    await insertDecision(actor_id, deployment_id, currentTick, 'cancelled', r.reason, fromDefId, target_def_id, actorBefore?.historyFingerprint ?? '0');
    await incrementFailed(deployment_id);
  }
}

async function checkDeploymentComplete(deploymentId) {
  const dep = await findDeploymentById(deploymentId);
  if (!dep) return;
  if (dep.status !== 'migrating') return;
  const processed = dep.migrated_count + dep.failed_count;
  if (processed >= dep.affected_actors) {
    const newStatus = dep.failed_count > 0 && dep.migrated_count === 0 ? 'failed' : 'complete';
    await updateDeploymentStatus(deploymentId, newStatus);
    console.log(`[migrate-worker] Deployment ${deploymentId} -> ${newStatus} (${dep.migrated_count} migrated, ${dep.failed_count} failed)`);
  }
}

async function processLoop() {
  while (true) {
    let hadWork = false;
    try {
      const jobs = await claimBatch(BATCH_SIZE);

      if (jobs.length > 0) {
        hadWork = true;
        console.log(`[migrate-worker] Processing ${jobs.length} migration jobs`);

        const CONCURRENCY = 20;
        for (let i = 0; i < jobs.length; i += CONCURRENCY) {
          const slice = jobs.slice(i, i + CONCURRENCY);
          await Promise.allSettled(slice.map(processJob));
        }

        const deploymentIds = [...new Set(jobs.map(j => j.deployment_id))];
        for (const depId of deploymentIds) await checkDeploymentComplete(depId);
      }
    } catch (err) {
      console.error('[migrate-worker] Error in process loop:', err);
    }
    await new Promise(r => { setTimeout(r, hadWork ? 50 : POLL_INTERVAL); });
  }
}

processLoop().catch(err => {
  console.error('[migrate-worker] Fatal error:', err);
  process.exit(1);
});
