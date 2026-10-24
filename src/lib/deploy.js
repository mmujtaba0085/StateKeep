/**
 * src/lib/deploy.js
 *
 * Definition deployment for embedded mode — the same routing model as the server:
 *   - deployments of one workflow are serialized and get a fresh time from the clock;
 *   - the deployment registers a change-point (wildcard, or a history pattern);
 *   - every routable actor of the family is then routed to a fixpoint in-process, under
 *     its lock, by the same rule and mappings as the server (there is no migrate worker
 *     in embedded mode, so this is also how stranded actors are reached by a rescue).
 * (It used to store the definition without a change-point: actors were queued for a
 *  worker that does not run in embedded mode and were never migrated.)
 */

import { randomUUID, createHash } from 'crypto';
import { createDefinition, updateCompiledJson, findDefinitionById } from '../registry/definitionRepo.js';
import { createDeployment, updateDeploymentStatus, incrementMigrated, incrementFailed } from '../registry/deploymentRepo.js';
import { findActorsByMachine } from '../registry/actorRepo.js';
import { insertChangepoint } from '../registry/changepointRepo.js';
import { nextDeployTick, withFamilyDeployLock } from '../registry/deployClock.js';
import { getEngine } from '../ffi/engine.js';
import { computeHistoryHash, fingerprintToBigInt } from '../ffi/hashUtils.js';
import { compileMachine } from '../runtime/definitionCompiler.js';
import { registerScalar, normalizeHistoryPath } from '../runtime/routingRegistry.js';
import {
  markChangepointRowRegistered, migrateActorOwned, routeTargetFor, invalidateMigrationCacheForDefinition,
} from '../runtime/actorManager.js';

export async function deployDefinition(definitionJson, {
  parentId, id: requestedId, historyPath, stateMapping, contextTransform,
} = {}) {
  try { compileMachine(definitionJson); } catch (e) {
    throw Object.assign(new Error(`Invalid definition: ${e.message}`), { code: 'INVALID_DEFINITION' });
  }
  const parent = parentId ? await findDefinitionById(parentId) : null;
  if (parentId && !parent) throw Object.assign(new Error(`Definition ${parentId} not found`), { code: 'NOT_FOUND' });
  const id = requestedId ?? randomUUID();
  const family = parent?.machineId ?? parentId ?? id;
  const path = normalizeHistoryPath(historyPath);
  const hasPath = Array.isArray(path) && path.length > 0;

  return withFamilyDeployLock(family, async () => {
    const eng = getEngine();
    const tStar = await nextDeployTick(eng);
    const stored = {
      ...definitionJson,
      _sourceHash: createHash('sha256').update(JSON.stringify(definitionJson)).digest('hex'),
      ...(stateMapping && Object.keys(stateMapping).length ? { _stateMapping: stateMapping } : {}),
      ...(contextTransform && Object.keys(contextTransform).length ? { _contextTransform: contextTransform } : {}),
      _historyPath: hasPath ? path : null,
      _historyRegions: null,
    };
    const machineId = await createDefinition({ id, parentId: parentId ?? null, definitionJson: stored, deployedAt: Number(tStar) });
    const { runtimeDef: _rt, ...compiledForm } = compileMachine(stored);
    await updateCompiledJson(id, compiledForm);

    const storedPrefix = hasPath ? fingerprintToBigInt(computeHistoryHash(path, 1)).toString() : '0';
    const rowId = await insertChangepoint({ tStar: Number(tStar), prefixHash: storedPrefix, refinement: 1, childDefId: id });
    registerScalar({ tStar, storedPrefix, childDefId: id, machineId: machineId ?? family, historyPath: hasPath ? path : null });
    markChangepointRowRegistered('cp', rowId);

    if (!parentId) return { id, machineId, deployedAt: Number(tStar) };
    try { invalidateMigrationCacheForDefinition(parentId); } catch {}

    // Route every actor of the family that has a pending route, in-process.
    // An actor that cannot be routed or migrated here is not lost: it stays on its current
    // version and is routed by the same rule before its next event (a failed lookup refuses
    // the event rather than running it unrouted), and stranded actors are retried by the
    // stranded-actor sweep. It is still reported, never counted as done.
    const actors = await findActorsByMachine(machineId ?? family);
    const pending = [];
    const failed = [];
    for (const a of actors) {
      let target = null;
      try { target = await routeTargetFor(a); }
      catch (e) { failed.push({ actorId: a.id, stage: 'routing', error: e.message }); continue; }
      if (target && target !== a.definitionId) pending.push(a.id);
    }
    const deploymentId = await createDeployment({ definitionId: id, affectedActors: pending.length + failed.length });
    let migrated = 0, stranded = 0, unchanged = 0;
    for (const actorId of pending) {
      let r;
      try { r = await migrateActorOwned(actorId, id, { deploymentId }); }
      catch (e) { failed.push({ actorId, stage: 'migration', error: e.message }); continue; }
      if (r?.outcome === 'migrated') { migrated++; await incrementMigrated(deploymentId).catch(() => {}); }
      else if (r?.outcome === 'needs_rescue') stranded++;
      else unchanged++;                       // finished meanwhile, or no longer applicable
    }
    for (let i = 0; i < failed.length; i++) await incrementFailed(deploymentId).catch(() => {});
    if (failed.length) {
      console.error(`[deploy] ${id}: ${failed.length} actor(s) could not be routed now; they stay on their `
        + `current version and are routed before their next event:`, failed.slice(0, 10));
    }
    await updateDeploymentStatus(deploymentId, failed.length && !migrated ? 'failed' : 'complete');
    return { id, machineId, deployedAt: Number(tStar), deploymentId, migrationJobs: pending.length,
      migrated, stranded, unchanged, failed: failed.length, failures: failed };
  });
}
