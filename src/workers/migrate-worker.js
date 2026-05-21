/**
 * src/workers/migrate-worker.js
 *
 * Background process: processes migration_jobs in batches of 100.
 * Managed by statekeep-migrate-worker.service (systemd).
 *
 * Algorithm:
 *   1. Poll migration_jobs WHERE status='pending' every 500ms
 *   2. Atomically claim up to 100 jobs (status -> 'processing')
 *   3. For each job: load actor, hydrate on new definition, update DB
 *   4. Report success/failure to deployments table
 *   5. Sleep and repeat
 */

import { getDb, encrypt } from '../registry/db.js';
import { startHeartbeat } from './heartbeat.js';
import { claimBatch, markDone, markFailed } from '../registry/jobRepo.js';
import { findActorById, updateActorStatus } from '../registry/actorRepo.js';
import { findDefinitionById } from '../registry/definitionRepo.js';
import { fingerprintToBigInt } from '../ffi/hashUtils.js';
import { incrementMigrated, incrementFailed, updateDeploymentStatus, findDeploymentById } from '../registry/deploymentRepo.js';
import { migrateActor, invalidateDefinitionCache } from '../runtime/actorManager.js';
import { getEngine, engineReady } from '../ffi/engine.js';
import { loadChangepointsAfter, loadParChangepointsAfter } from '../registry/changepointRepo.js';

const BATCH_SIZE    = 100;
const POLL_INTERVAL = 500;   // ms

const API_PORT  = process.env.PORT ?? 3001;
const ADMIN_KEY = process.env.STATEKEEP_ADMIN_KEY ?? '';

async function evictFromApiCache(actorId) {
  try {
    await fetch(`http://localhost:${API_PORT}/v1/internal/cache/evict`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body:    JSON.stringify({ actorId }),
    });
  } catch {
    // Non-fatal: the stale-cache staleness check in actorManager.sendEvent is the safety net.
  }
}

console.log('[migrate-worker] Starting...');

await engineReady;
getDb();  // bootstrap DB
startHeartbeat('migrate');

// Cursors track the highest id already registered for each changepoint type.
let _lastChangepointId    = 0;
let _lastParChangepointId = 0;

function syncRegistry() {
  const eng = getEngine();
  if (!eng.available) return;

  const rows = loadChangepointsAfter(_lastChangepointId);
  for (const row of rows) {
    try {
      eng.registerChangepoint(
        BigInt(row.t_star),
        BigInt(row.prefix_hash),
        BigInt(row.refinement),
        row.child_def_id
      );
      _lastChangepointId = row.id;
    } catch (e) {
      console.warn(`[migrate-worker] syncRegistry skip ${row.child_def_id}: ${e.message}`);
    }
  }
  if (rows.length > 0) {
    console.log(`[migrate-worker] Registry synced: +${rows.length} scalar changepoints (cursor=${_lastChangepointId})`);
  }

  // Seed parallel changepoints (per-region FNV prefix classes)
  const parRows = loadParChangepointsAfter(_lastParChangepointId);
  for (const row of parRows) {
    try {
      const regionHexArr = JSON.parse(row.region_hashes);
      const regionArr    = regionHexArr.map(h => BigInt(`0x${h.padStart(16, '0')}`));
      eng.registerChangepointParallel(
        BigInt(row.t_star),
        regionArr,
        BigInt(row.refinement),
        row.child_def_id
      );
      _lastParChangepointId = row.id;
    } catch (e) {
      console.warn(`[migrate-worker] syncRegistry skip parallel ${row.child_def_id}: ${e.message}`);
    }
  }
  if (parRows.length > 0) {
    console.log(`[migrate-worker] Registry synced: +${parRows.length} parallel changepoints (cursor=${_lastParChangepointId})`);
  }
}

syncRegistry();  // seed from DB on startup (loads whatever exists at boot time)

async function processJob(job) {
  const { id, actor_id, org_id, target_def_id, deployment_id } = job;

  // Load actor before migration to capture fromState for the event log
  const actorBefore = findActorById(actor_id);
  const fromState   = actorBefore?.stateValue ?? null;
  const fromDefId   = actorBefore?.definitionId ?? null;

  const db  = getDb();
  const eng = getEngine();
  const currentTick = Number(eng.clockTick());

  // Re-check that this actor is still eligible — fingerprint may have changed since enqueue.
  // Use the same logicalTime as the server used when creating the job: if the actor has already
  // migrated at least once (currentDeployedAt > logicalStartTick), search strictly after the
  // current definition's registration tick so chained deployments are found correctly.
  if (eng.available && actorBefore) {
    let recheck = null;
    try {
      const actorCurrentDef    = findDefinitionById(actorBefore.definitionId);
      const currentDeployedAt  = actorCurrentDef?.deployedAt ?? 0;
      const logicalStartTick   = actorBefore.logicalStartTick ?? 0;
      const recheckLogicalTime = currentDeployedAt > logicalStartTick
        ? BigInt(currentDeployedAt) + 1n
        : BigInt(logicalStartTick);

      recheck = eng.computeAccessible(
        fingerprintToBigInt(actorBefore.historyFingerprint),
        recheckLogicalTime,
        BigInt(currentTick)
      );
    } catch {}

    if (!recheck || recheck !== target_def_id) {
      markFailed(id, 'cancelled: fingerprint_changed');
      try {
        db.prepare(`
          INSERT INTO migration_decisions
            (actor_id, org_id, deployment_id, trigger, evaluated_at, decision, reason,
             from_definition_id, to_definition_id, actor_fingerprint, prefix_hash, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          actor_id, org_id ?? 'default', deployment_id, 'batch_worker', currentTick,
          'cancelled', 'fingerprint_changed',
          fromDefId, target_def_id,
          actorBefore.historyFingerprint, '0', Date.now()
        );
      } catch (e) {
        console.warn(`[migrate-worker] decision log failed for ${actor_id}: ${e.message}`);
      }
      incrementFailed(deployment_id);
      return;
    }
  }

  // Mark actor as migrating
  updateActorStatus(actor_id, 'migrating');

  try {
    invalidateDefinitionCache(target_def_id);
    const result = await migrateActor(actor_id, target_def_id);

    // Gap 5 fix: notify engine that the actor has started on the new definition.
    // t_star      = the engine tick at which the TARGET definition was deployed
    // prefix_hash = the actor's CURRENT history fingerprint after migration
    const targetDef     = findDefinitionById(target_def_id);
    const migratedActor = findActorById(actor_id);
    if (migratedActor && targetDef) {
      try {
        eng.actorStarted(
          BigInt(targetDef.deployedAt),
          fingerprintToBigInt(migratedActor.historyFingerprint)
        );
      } catch (e) {
        console.warn(`[migrate-worker] actorStarted notification failed for ${actor_id}: ${e.message}`);
      }
    }

    // Write MIGRATED event to immutable log
    db.prepare(`
      INSERT INTO events (actor_id, org_id, event_type, event_payload, tick, processed_at)
      VALUES (?, ?, 'MIGRATED', ?, ?, ?)
    `).run(
      actor_id,
      org_id,
      encrypt(Buffer.from(JSON.stringify({
        fromDefinitionId: fromDefId,
        toDefinitionId:   target_def_id,
        fromState,
        toState:          result.stateValue,
      }))),
      currentTick,
      Date.now()
    );

    markDone(id);
    incrementMigrated(deployment_id);
    // Evict the hot registry entry on the API server so the next event is dispatched
    // against the new definition, not the stale cached one.
    evictFromApiCache(actor_id);
  } catch (err) {
    if (err.code === 'STATE_NOT_MAPPABLE' || err.code === 'CONTEXT_TRANSFORM_FAILED') {
      // Actor cannot be migrated — tag needs_rescue, do NOT call actorStarted
      console.warn(`[migrate-worker] Job ${id}: actor ${actor_id} needs_rescue — ${err.message}`);
      updateActorStatus(actor_id, 'needs_rescue');

      db.prepare(`
        INSERT INTO events (actor_id, org_id, event_type, event_payload, tick, processed_at)
        VALUES (?, ?, 'MIGRATION_FAILED', ?, ?, ?)
      `).run(
        actor_id,
        org_id,
        encrypt(Buffer.from(JSON.stringify({
          fromDefinitionId: fromDefId,
          toDefinitionId:   target_def_id,
          reason:           err.code,
          stateValue:       err.currentStateValue ?? null,
          message:          err.message,
        }))),
        currentTick,
        Date.now()
      );

      markFailed(id, `${err.code}: ${err.currentStateValue ?? err.message}`);
    } else {
      console.error(`[migrate-worker] Job ${id} failed for actor ${actor_id}:`, err.message);
      updateActorStatus(actor_id, 'active');   // rollback to active so actor still works
      markFailed(id, err.message);
    }
    incrementFailed(deployment_id);
  }
}

async function checkDeploymentComplete(deploymentId) {
  const dep = findDeploymentById(deploymentId);
  if (!dep) return;
  if (dep.status !== 'migrating') return;

  const total     = dep.affected_actors;
  const processed = dep.migrated_count + dep.failed_count;
  if (processed >= total) {
    const newStatus = dep.failed_count > 0 && dep.migrated_count === 0 ? 'failed' : 'complete';
    updateDeploymentStatus(deploymentId, newStatus);
    console.log(`[migrate-worker] Deployment ${deploymentId} -> ${newStatus} (${dep.migrated_count} migrated, ${dep.failed_count} failed)`);
  }
}

async function processLoop() {
  while (true) {
    try {
      syncRegistry();  // pick up any changepoints registered since last poll
      const jobs = claimBatch(BATCH_SIZE);

      if (jobs.length > 0) {
        console.log(`[migrate-worker] Processing ${jobs.length} migration jobs`);

        // Process all jobs in this batch concurrently (but cap at 20 parallel)
        const CONCURRENCY = 20;
        for (let i = 0; i < jobs.length; i += CONCURRENCY) {
          const slice = jobs.slice(i, i + CONCURRENCY);
          await Promise.allSettled(slice.map(processJob));
        }

        // Check if any deployments are now complete
        const deploymentIds = [...new Set(jobs.map(j => j.deployment_id))];
        for (const depId of deploymentIds) {
          await checkDeploymentComplete(depId);
        }
      }
    } catch (err) {
      console.error('[migrate-worker] Error in process loop:', err);
    }

    await new Promise(r => setTimeout(r, jobs.length > 0 ? 50 : POLL_INTERVAL));
  }
}

processLoop().catch(err => {
  console.error('[migrate-worker] Fatal error:', err);
  process.exit(1);
});