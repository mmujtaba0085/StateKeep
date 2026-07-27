/**
 * src/lib/deploy.js
 *
 * Simplified definition deployment for embedded mode.
 * Handles create (first version) and upgrade (new version from parent).
 */

import { randomUUID } from 'crypto';
import { createDefinition, updateCompiledJson } from '../registry/definitionRepo.js';
import { createDeployment, updateDeploymentStatus } from '../registry/deploymentRepo.js';
import { enqueueJobs } from '../registry/jobRepo.js';
import { findActorsByMachine } from '../registry/actorRepo.js';
import { getEngine } from '../ffi/engine.js';
import { compileMachine } from '../runtime/definitionCompiler.js';

export async function deployDefinition(definitionJson, {
  parentId,
} = {}) {
  try { compileMachine(definitionJson); } catch (e) {
    throw Object.assign(new Error(`Invalid definition: ${e.message}`), { code: 'INVALID_DEFINITION' });
  }

  const eng   = getEngine();
  const tStar = Number(eng.clockTick());
  const id    = randomUUID();

  const machineId = await createDefinition({ id, parentId: parentId ?? null, definitionJson, deployedAt: tStar });

  // Compile and store compiled form so main-thread interpreter can process events.
  // Propagate failures: a NULL compiled_json means all subsequent sendEvents fail.
  const { runtimeDef: _rt, ...compiledForm } = compileMachine(definitionJson);
  await updateCompiledJson(id, compiledForm);

  if (!parentId) {
    return { id, machineId, deployedAt: tStar };
  }

  // Wildcard migration: all active actors on the same machine family
  const affected = await findActorsByMachine(machineId);
  if (affected.length === 0) {
    return { id, machineId, deployedAt: tStar, migrationJobs: 0 };
  }

  const deploymentId = await createDeployment({ definitionId: id, affectedActors: affected.length });

  await enqueueJobs(affected.map(a => ({
    deployment_id: deploymentId,
    actor_id:      a.id,
    target_def_id: id,
  })));

  await updateDeploymentStatus(deploymentId, 'migrating');

  return { id, machineId, deployedAt: tStar, deploymentId, migrationJobs: affected.length };
}
