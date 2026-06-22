/**
 * src/lib/deploy.js
 *
 * Simplified definition deployment for embedded mode.
 * Handles create (first version) and upgrade (new version from parent).
 */

import { createMachine } from 'xstate';
import { randomUUID } from 'crypto';
import { createDefinition, findDefinitionById } from '../registry/definitionRepo.js';
import { createDeployment, updateDeploymentStatus } from '../registry/deploymentRepo.js';
import { enqueueJobs } from '../registry/jobRepo.js';
import { findActorsByMachine } from '../registry/actorRepo.js';
import { getEngine } from '../ffi/engine.js';

export async function deployDefinition(definitionJson, {
  orgId    = 'default',
  parentId,
} = {}) {
  try { createMachine(definitionJson); } catch (e) {
    throw Object.assign(new Error(`Invalid definition: ${e.message}`), { code: 'INVALID_DEFINITION' });
  }

  const eng   = getEngine();
  const tStar = Number(eng.clockTick());
  const id    = randomUUID();

  await createDefinition({ id, parentId: parentId ?? null, orgId, definitionJson, deployedAt: tStar });

  const def = await findDefinitionById(id);
  if (!def) throw new Error('Definition create failed');

  if (!parentId) {
    return { id, machineId: def.machineId, deployedAt: tStar };
  }

  // Wildcard migration: all active actors on the same machine family
  const affected = await findActorsByMachine(def.machineId, orgId);
  if (affected.length === 0) {
    return { id, machineId: def.machineId, deployedAt: tStar, migrationJobs: 0 };
  }

  const deploymentId = await createDeployment({ definitionId: id, affectedActors: affected.length, orgId });
  await updateDeploymentStatus(deploymentId, 'migrating');

  await enqueueJobs(affected.map(a => ({
    deployment_id: deploymentId,
    actor_id:      a.id,
    org_id:        orgId,
    target_def_id: id,
  })));

  return { id, machineId: def.machineId, deployedAt: tStar, deploymentId, migrationJobs: affected.length };
}
