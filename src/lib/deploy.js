/**
 * src/lib/deploy.js
 *
 * Simplified definition deployment for embedded mode.
 * Handles create (first version) and upgrade (new version from parent).
 */

import { createMachine } from 'xstate';
import { randomUUID } from 'crypto';
import { createDefinition, updateCompiledJson } from '../registry/definitionRepo.js';
import { createDeployment, updateDeploymentStatus } from '../registry/deploymentRepo.js';
import { enqueueJobs } from '../registry/jobRepo.js';
import { findActorsByMachine } from '../registry/actorRepo.js';
import { getEngine } from '../ffi/engine.js';
import { compileMachine } from '../runtime/definitionCompiler.js';

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

  const machineId = await createDefinition({ id, parentId: parentId ?? null, orgId, definitionJson, deployedAt: tStar });

  // Compile and store compiled form so main-thread interpreter can process events
  try {
    const { runtimeDef: _rt, ...compiledForm } = compileMachine(definitionJson);
    await updateCompiledJson(id, compiledForm);
  } catch (compileErr) {
    console.warn(`[deploy] Compile warning for ${id}:`, compileErr.message);
  }

  if (!parentId) {
    return { id, machineId, deployedAt: tStar };
  }

  // Wildcard migration: all active actors on the same machine family
  const affected = await findActorsByMachine(machineId, orgId);
  if (affected.length === 0) {
    return { id, machineId, deployedAt: tStar, migrationJobs: 0 };
  }

  const deploymentId = await createDeployment({ definitionId: id, affectedActors: affected.length, orgId });
  await updateDeploymentStatus(deploymentId, 'migrating');

  await enqueueJobs(affected.map(a => ({
    deployment_id: deploymentId,
    actor_id:      a.id,
    org_id:        orgId,
    target_def_id: id,
  })));

  return { id, machineId, deployedAt: tStar, deploymentId, migrationJobs: affected.length };
}
