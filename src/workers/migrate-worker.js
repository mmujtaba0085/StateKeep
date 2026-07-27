/**
 * src/workers/migrate-worker.js
 *
 * Background process: processes migration_jobs in batches.
 */

import { getDb, encrypt, isPostgres } from '../registry/db.js';
import { startHeartbeat } from './heartbeat.js';
import { claimBatch, markDone, markFailed, resetProcessingJobs } from '../registry/jobRepo.js';
import { findActorById, updateActorStatus } from '../registry/actorRepo.js';
import { findDefinitionById } from '../registry/definitionRepo.js';
import { fingerprintToBigInt, regionFingerprintsToArray } from '../ffi/hashUtils.js';
import { incrementMigrated, incrementFailed, updateDeploymentStatus, findDeploymentById } from '../registry/deploymentRepo.js';
import { migrateActor, invalidateDefinitionCache, seedEngineRegistry } from '../runtime/actorManager.js';
import { insertMigrationNotification } from '../registry/migrationNotificationRepo.js';
import { getEngine, engineReady } from '../ffi/engine.js';
import { getWildcardChildDef, loadChangepointsAfter, loadParChangepointsAfter } from '../registry/changepointRepo.js';

const BATCH_SIZE    = 500;
const POLL_INTERVAL = 500;

const API_PORT  = process.env.PORT ?? 3001;
const ADMIN_KEY = process.env.STATEKEEP_ADMIN_KEY ?? '';

async function evictFromApiCache(actorId) {
  try {
    await fetch(`http://localhost:${API_PORT}/v1/internal/cache/evict`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body:    JSON.stringify({ actorId }),
    });
  } catch {}
}

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

// Cursors for incremental changepoint sync
let _lastChangepointId    = 0;
let _lastParChangepointId = 0;

async function syncRegistry() {
  const eng = getEngine();
  if (!eng.available) return;

  const rows = await loadChangepointsAfter(_lastChangepointId);
  for (const row of rows) {
    try {
      eng.registerChangepoint(BigInt(row.t_star), BigInt(row.prefix_hash), BigInt(row.refinement), row.child_def_id);
      _lastChangepointId = row.id;
    } catch (e) {
      console.warn(`[migrate-worker] syncRegistry skip ${row.child_def_id}: ${e.message}`);
    }
  }
  if (rows.length > 0) {
    console.log(`[migrate-worker] Registry synced: +${rows.length} scalar changepoints (cursor=${_lastChangepointId})`);
  }

  const parRows = await loadParChangepointsAfter(_lastParChangepointId);
  for (const row of parRows) {
    try {
      const storedRegions = JSON.parse(row.region_hashes);
      const regionArr = Array.isArray(storedRegions)
        ? storedRegions.map(h => BigInt(`0x${String(h).padStart(16, '0')}`))
        : regionFingerprintsToArray(storedRegions);
      if (!regionArr || regionArr.length === 0) { _lastParChangepointId = row.id; continue; }
      eng.registerChangepointParallel(BigInt(row.t_star), regionArr, BigInt(row.refinement), row.child_def_id);
      _lastParChangepointId = row.id;
    } catch (e) {
      console.warn(`[migrate-worker] syncRegistry skip parallel ${row.child_def_id}: ${e.message}`);
    }
  }
  if (parRows.length > 0) {
    console.log(`[migrate-worker] Registry synced: +${parRows.length} parallel changepoints (cursor=${_lastParChangepointId})`);
  }
}

await syncRegistry();

async function insertEvent(actorId, eventType, payload, tick) {
  const encPayload = encrypt(Buffer.from(JSON.stringify(payload)));
  if (isPostgres) {
    const { query } = await import('../registry/db-postgres.js');
    await query(
      `INSERT INTO events (actor_id, event_type, event_payload, tick, processed_at) VALUES ($1,$2,$3,$4,$5)`,
      [actorId, eventType, encPayload, tick, Date.now()]
    );
  } else {
    getDb().prepare(
      `INSERT INTO events (actor_id, event_type, event_payload, tick, processed_at) VALUES (?, ?, ?, ?, ?)`
    ).run(actorId, eventType, encPayload, tick, Date.now());
  }
}

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

  const actorBefore = await findActorById(actor_id);
  const fromState   = actorBefore?.stateValue ?? null;
  const fromDefId   = actorBefore?.definitionId ?? null;

  const eng = getEngine();
  const currentTick = Number(eng.clockTick());

  const targetDefForRecheck = actorBefore ? await findDefinitionById(target_def_id) : null;
  const isWildcardDeploy    = !targetDefForRecheck?.definitionJson?._historyPath &&
                              !targetDefForRecheck?.definitionJson?._historyRegions;

  if (eng.available && actorBefore && actorBefore.status !== 'needs_rescue' && !isWildcardDeploy) {
    let recheck = null;
    try {
      const actorCurrentDef    = await findDefinitionById(actorBefore.definitionId);
      const currentDeployedAt  = actorCurrentDef?.deployedAt ?? 0;
      const logicalStartTick   = actorBefore.logicalStartTick ?? 0;
      const wildcardLowerBound = currentDeployedAt > logicalStartTick ? currentDeployedAt : logicalStartTick;
      const recheckLogicalTime = currentDeployedAt > logicalStartTick
        ? BigInt(currentDeployedAt) + 1n
        : BigInt(logicalStartTick);

      recheck = eng.computeAccessible(fingerprintToBigInt(actorBefore.historyFingerprint), recheckLogicalTime, BigInt(currentTick));

      if (!recheck) recheck = await getWildcardChildDef(actorBefore.definitionId, wildcardLowerBound);

      if (!recheck && actorBefore.regionFingerprints) {
        const regionArr = regionFingerprintsToArray(actorBefore.regionFingerprints);
        if (regionArr && regionArr.length > 0) {
          recheck = eng.computeAccessibleParallel(regionArr, recheckLogicalTime, BigInt(currentTick));
        }
      }
    } catch {}

    if (!recheck || recheck !== target_def_id) {
      await markFailed(id, 'cancelled: fingerprint_changed');
      await insertDecision(actor_id, deployment_id, currentTick, 'cancelled', 'fingerprint_changed', fromDefId, target_def_id, actorBefore.historyFingerprint);
      await incrementFailed(deployment_id);
      return;
    }
  }

  await updateActorStatus(actor_id, 'migrating');

  try {
    invalidateDefinitionCache(target_def_id);
    const result = await migrateActor(actor_id, target_def_id, { priority: 'low' });

    const targetDef     = await findDefinitionById(target_def_id);
    const migratedActor = await findActorById(actor_id);
    if (migratedActor && targetDef) {
      try {
        eng.actorStarted(BigInt(targetDef.deployedAt), fingerprintToBigInt(migratedActor.historyFingerprint));
      } catch (e) {
        console.warn(`[migrate-worker] actorStarted notification failed for ${actor_id}: ${e.message}`);
      }
    }

    // Mark job done before inserting the audit event so a transient DB error on
    // insertEvent cannot leave the job in 'migrating' state and trigger a re-migration.
    await markDone(id);
    await incrementMigrated(deployment_id);
    await insertEvent(actor_id, 'MIGRATED', {
      fromDefinitionId: fromDefId,
      toDefinitionId:   target_def_id,
      fromState,
      toState:          result.stateValue,
    }, currentTick).catch(err =>
      console.warn(`[migrate-worker] MIGRATED event insert failed for ${actor_id}:`, err.message)
    );
    await insertMigrationNotification(actor_id, fromDefId, target_def_id).catch(() => {});
    evictFromApiCache(actor_id);
  } catch (err) {
    if (err.code === 'STATE_NOT_MAPPABLE' || err.code === 'CONTEXT_TRANSFORM_FAILED') {
      console.warn(`[migrate-worker] Job ${id}: actor ${actor_id} needs_rescue — ${err.message}`);
      await updateActorStatus(actor_id, 'needs_rescue');

      // Advance actor to target definition so future rescue deployments find it
      if (isPostgres) {
        const { query } = await import('../registry/db-postgres.js');
        await query(`UPDATE actors SET definition_id=$1 WHERE id=$2`, [target_def_id, actor_id]);
      } else {
        getDb().prepare(`UPDATE actors SET definition_id = ? WHERE id = ?`).run(target_def_id, actor_id);
      }
      evictFromApiCache(actor_id);

      await insertEvent(actor_id, 'MIGRATION_FAILED', {
        fromDefinitionId: fromDefId,
        toDefinitionId:   target_def_id,
        reason:           err.code,
        stateValue:       err.currentStateValue ?? null,
        message:          err.message,
      }, currentTick);

      await markFailed(id, `${err.code}: ${err.currentStateValue ?? err.message}`);
    } else {
      console.error(`[migrate-worker] Job ${id} failed for actor ${actor_id}:`, err.message);
      await updateActorStatus(actor_id, 'active');
      await markFailed(id, err.message);
    }
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
      await syncRegistry();
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
    await new Promise(r => setTimeout(r, hadWork ? 50 : POLL_INTERVAL));
  }
}

processLoop().catch(err => {
  console.error('[migrate-worker] Fatal error:', err);
  process.exit(1);
});
