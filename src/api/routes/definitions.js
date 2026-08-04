/**
 * src/api/routes/definitions.js
 *
 * PUT    /v1/definitions              — Deploy new statechart version
 * GET    /v1/definitions/:id/status   — Deployment + migration status
 * GET    /v1/definitions/:id/diff     — State diff vs parent
 * GET    /v1/definitions              — List all definitions
 *
 * ── Validation before storage ────────────────────────────────────────────────
 * Hard errors (EMPTY_STATES, INVALID_INITIAL, etc.) → 400, nothing stored.
 * Soft warnings (DEAD_END_STATE, UNREACHABLE_STATE, NO_TERMINAL_STATE) → stored
 * with 201, warnings included in response so the caller can act.
 *
 * ── Stranded-actor confirm flow ───────────────────────────────────────────────
 * When a new version removes states that are currently occupied by active actors
 * those actors would become stranded (needs_rescue).
 *
 * First PUT (no confirmToken):
 *   → returns 200 `requires_confirmation` with strandedActors list + confirmToken
 *   → nothing is written to the DB
 *
 * Second PUT (with confirmToken in body):
 *   → server verifies token (not expired, correct def, no large actor drift)
 *   → stores definition, tags stranded actors as needs_rescue
 *   → returns 201 as normal
 *
 * If there are NO stranded actors the confirm flow is skipped entirely.
 */

import { createHash }   from 'crypto';
import { getDb, isPostgres } from '../../registry/db.js';
import {
  findDefinitionById,
  createDefinition,
  updateDefinitionJson,
  updateCompiledJson,
  listDefinitions,
  findDefinitionsByMachine,
  deprecateDefinition,
} from '../../registry/definitionRepo.js';
import { compileMachine } from '../../runtime/definitionCompiler.js';
import { validateDefinitionAgainstRegistry, getGlobalRegistry } from '../../runtime/implementationRegistry.js';
import {
  findDeploymentsByDefinition,
  createDeployment,
  updateDeploymentStatus,
} from '../../registry/deploymentRepo.js';
import {
  findActorsByDefinition,
  findActorsByMachine,
  findStrandedActors,
  bulkTagNeedsRescue,
} from '../../registry/actorRepo.js';
import { enqueueJobs, findDecisionsByDeployment } from '../../registry/jobRepo.js';
import { getEngine }                  from '../../ffi/engine.js';
import { invalidateMigrationCacheForDefinition, evictFromHotRegistry, invalidateDefinitionCache } from '../../runtime/actorManager.js';
import { computeHash, computeHistoryHash, fingerprintToBigInt, computeRegionHashes, regionFingerprintsToArray } from '../../ffi/hashUtils.js';
import { analyseDefinition }          from '../lib/staticAnalysis.js';
import { issueToken, consumeToken }   from '../../registry/confirmTokenStore.js';
import { insertChangepoint, insertParChangepoint } from '../../registry/changepointRepo.js';
import { normalizeHistoryRegions } from '../../runtime/statePaths.js';
import { getWriteBuffer } from '../../runtime/writeBuffer.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Stable hex hash of a definition JSON (for token drift detection). */
function hashDefinition(definition) {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

// ── Shared evaluation helper ─────────────────────────────────────────────────

/**
 * Evaluate migration candidates across the FULL machine family (all versions).
 * machineId is the root definition's id — the same value stored as machine_id
 * on every definition in the family tree.
 *
 * When hasHistoryTarget = false (wildcard deploy), all active actors are returned
 * as wouldMigrate without calling the engine (engine uses exact prefix match,
 * not wildcard, for prefix_hash=0).
 */
async function evaluateMigrationCandidates(machineId, eng, currentTick, hasHistoryTarget = true) {
  const actors     = await findActorsByMachine(machineId);
  const wouldMigrate = [];
  const wouldStay    = [];

  if (!hasHistoryTarget) {
    // Wildcard: every active actor on the machine is eligible
    for (const actor of actors) {
      wouldMigrate.push({
        actorId:            actor.id,
        currentState:       actor.stateValue,
        definitionId:       actor.definitionId,
        targetDefinitionId: null,  // not yet known — definition hasn't been stored
      });
    }
    return { eligible: actors.length, wouldMigrate, wouldStay, engineAvailable: eng.available };
  }

  for (const actor of actors) {
    let targetDefId = null;
    try {
      const actorFp = fingerprintToBigInt(actor.historyFingerprint);
      targetDefId   = eng.computeAccessible(actorFp, BigInt(actor.logicalStartTick), currentTick);
      if (!targetDefId && actor.regionFingerprints) {
        const regionArr = regionFingerprintsToArray(actor.regionFingerprints);
        if (regionArr && regionArr.length > 0) {
          targetDefId = eng.computeAccessibleParallel(regionArr, BigInt(actor.logicalStartTick), currentTick);
        }
      }
    } catch {}

    if (targetDefId && targetDefId !== actor.definitionId) {
      wouldMigrate.push({
        actorId:          actor.id,
        currentState:     actor.stateValue,
        definitionId:     actor.definitionId,
        targetDefinitionId: targetDefId,
      });
    } else {
      wouldStay.push({
        actorId:      actor.id,
        currentState: actor.stateValue,
        definitionId: actor.definitionId,
        reason:       'fingerprint_mismatch',
      });
    }
  }

  return { eligible: actors.length, wouldMigrate, wouldStay };
}

export async function definitionRoutes(fastify) {

  // ── PUT /v1/definitions ────────────────────────────────────────────────────
  fastify.put('/v1/definitions', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          dryRun: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['id', 'definition'],
        properties: {
          id:           { type: 'string', minLength: 1, maxLength: 200 },
          parentId:     { type: 'string' },
          definition:   { type: 'object' },
          refinement:   { type: 'integer', default: 1 },
          confirmToken: { type: 'string' },
          historyPath:  {
            type:        'array',
            items:       { type: 'string', minLength: 1 },
            description: 'Ordered list of event types that an actor must have processed ' +
                         'to be eligible for this deployment. Absent or empty = wildcard (all actors).',
          },
          stateMapping: {
            type:        'object',
            description: 'Maps old state names to new state names for actors that migrate. ' +
                         'Keys are old state names, values are new state names.',
            additionalProperties: { type: 'string' },
          },
          historyRegions: {
            type:        'object',
            description: 'Parallel region fingerprint selectors. Keys are region names, values are ' +
                         'ordered event-type arrays. All regions must match (AND composition). ' +
                         'Targets actors on parallel XState machines. Mutually exclusive with historyPath.',
            additionalProperties: { type: 'array', items: { type: 'string' } },
          },
          contextTransform: {
            type:        'object',
            description: 'Maps new context field paths to old field paths using dot-notation. ' +
                         'New fields are added; old fields are preserved (additive). ' +
                         'Example: { "payment.verified": "feePaid" }',
            additionalProperties: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { id, parentId, definition, refinement = 1, confirmToken, historyPath, stateMapping, historyRegions, contextTransform } = request.body;
    const isDryRun          = request.query?.dryRun === 'true';
    const eng               = getEngine();
    const hasHistoryPath    = Array.isArray(historyPath) && historyPath.length > 0;
    const hasHistoryRegions = historyRegions && typeof historyRegions === 'object' &&
                              !Array.isArray(historyRegions) &&
                              Object.keys(historyRegions).length > 0;
    const hasHistoryTarget  = !!(hasHistoryPath || hasHistoryRegions);
    const parentDefForTargeting = parentId ? await findDefinitionById(parentId) : null;

    if (parentId && !parentDefForTargeting) {
      return reply.code(404).send({ error: `Definition ${parentId} not found` });
    }

    if (parentId === id) {
      return reply.code(400).send({ error: 'A definition cannot be its own parent' });
    }

    if (hasHistoryPath && hasHistoryRegions) {
      return reply.code(400).send({
        error: 'historyPath and historyRegions are mutually exclusive. Use historyPath for scalar routing or historyRegions for parallel-region routing.',
      });
    }

    if (hasHistoryTarget && !parentId) {
      return reply.code(400).send({
        error: 'historyPath/historyRegions require parentId because history targeting selects actors from an existing parent definition.',
      });
    }

    let normalizedHistoryRegions = null;
    if (hasHistoryRegions) {
      try {
        normalizedHistoryRegions = normalizeHistoryRegions(
          historyRegions,
          parentDefForTargeting.definitionJson
        );
      } catch (err) {
        return reply.code(400).send({ error: err.message });
      }
    }

    // ── Idempotency ──────────────────────────────────────────────────────────
    // A re-deploy of the same ID is idempotent only when historyPath AND
    // stateMapping both match. Changing either is a meaningful update (new
    // refinement) — not an error — so we fall through to create a new deployment.
    // Changing historyPath alone is still a 409 (user error: ambiguous changepoint).
    const existing = await findDefinitionById(id);
    if (existing) {
      const normaliseHP  = (hp) => (Array.isArray(hp) && hp.length > 0) ? hp : null;
      const normaliseHR  = (hr) => (hr && typeof hr === 'object' && !Array.isArray(hr) && Object.keys(hr).length > 0) ? hr : null;
      const normaliseSM  = (sm) => (sm && Object.keys(sm).length > 0) ? sm : null;
      const incomingHP   = normaliseHP(historyPath);
      const storedHP     = normaliseHP(existing.definitionJson._historyPath);
      const incomingHR   = normaliseHR(normalizedHistoryRegions);
      const storedHR     = normaliseHR(existing.definitionJson._historyRegions);
      const incomingSM   = normaliseSM(stateMapping);
      const storedSM     = normaliseSM(existing.definitionJson._stateMapping);
      const historyChanged  = JSON.stringify(incomingHP) !== JSON.stringify(storedHP) ||
                              JSON.stringify(incomingHR) !== JSON.stringify(storedHR);
      const mappingChanged  = JSON.stringify(incomingSM) !== JSON.stringify(storedSM);

      // Strip internal _ fields from stored JSON before comparing definition content
      const storedDefClean  = Object.fromEntries(Object.entries(existing.definitionJson).filter(([k]) => !k.startsWith('_')));
      const definitionChanged = JSON.stringify(definition) !== JSON.stringify(storedDefClean);

      if (historyChanged) {
        return reply.code(409).send({
          error:               `Definition ${id} already exists with different history targeting. Deploy under a new version ID.`,
          existingHistoryPath: storedHP,
          incomingHistoryPath: incomingHP,
          existingHistoryRegions: storedHR,
          incomingHistoryRegions: incomingHR,
        });
      }

      // stateMapping or definition content changed → treat as a new refinement (fall through to deploy)
      if (!mappingChanged && !definitionChanged) {
        return reply.code(200).send({
          id,
          parentId:        existing.parentId,
          deployedAt:      existing.deployedAt,
          deploymentId:    null,
          affectedActors:  0,
          engineAvailable: eng.available,
          idempotent:      true,
        });
      }
    }

    // ── Step 1: Validate definition before storing ──────────────────────────
    const { errors, warnings } = analyseDefinition(definition);
    if (errors.length > 0) {
      return reply.code(400).send({
        error:      `Invalid machine definition: ${errors[0].message}`,
        errors,
        warnings,
        ...(isDryRun ? { dryRun: true, valid: false, wouldDeploy: false } : {}),
      });
    }

    // Actors in states that are KEYS of stateMapping have a forward migration path
    // and must not be considered stranded. Compute this once for all stranded checks.
    const newStateNames = Object.keys(definition.states ?? {});
    const effectiveValidStates = stateMapping && Object.keys(stateMapping).length > 0
      ? [...new Set([...newStateNames, ...Object.keys(stateMapping)])]
      : newStateNames;

    // Resolve machineId for the full family scope (used in both dryRun and live paths)
    let machineId = id;
    if (parentId) {
      const parentDef = parentDefForTargeting;
      machineId = parentDef?.machineId ?? parentId;
    }

    // ── dryRun: evaluate without writing anything ──────────────────────────────
    if (isDryRun) {
      const dryRunTick = eng.clockTick();
      let migration = { eligible: 0, wouldMigrate: [], wouldStay: [], engineAvailable: eng.available };

      if (parentId && eng.available) {
        const candidates = await evaluateMigrationCandidates(machineId, eng, dryRunTick, hasHistoryTarget);
        migration = { ...candidates, engineAvailable: true };
      } else if (parentId) {
        const dryActors = await findActorsByMachine(machineId);
        migration = {
          eligible:        dryActors.length,
          wouldMigrate:    [],
          wouldStay:       dryActors.map(a => ({ actorId: a.id, currentState: a.stateValue, definitionId: a.definitionId, reason: 'engine_unavailable' })),
          engineAvailable: false,
          note:            'APV engine unavailable — build WASM with `make wasm -C src/ffi` or set STATEKEEP_ENGINE_PATH.',
        };
      }

      // Compute stranded actors for the dryRun preview
      let dryStrandedActors = [];
      if (parentId) {
        const strandedGroups = await findStrandedActors(parentId, effectiveValidStates);
        dryStrandedActors    = strandedGroups.map(g => ({ currentState: g.state, count: g.count }));
      }

      const wouldDeploy = dryStrandedActors.length === 0;
      return reply.code(200).send({
        dryRun:         true,
        valid:          true,
        warnings,
        wouldDeploy,
        strandedActors: dryStrandedActors,
        migration,
      });
    }

    // ── Step 2: Stranded-actor check (only when parentId is supplied) ────────
    // Flush deferred writes so the DB reflects the latest actor states before
    // we query for stranded actors (avoids false-negative when a recent event
    // hasn't been written yet by the 50ms write-buffer timer).
    if (parentId) await getWriteBuffer().flush();

    if (parentId) {
      const strandedGroups = await findStrandedActors(parentId, effectiveValidStates);
      const totalStranded  = strandedGroups.reduce((s, g) => s + g.count, 0);

      if (totalStranded > 0) {
        // ── Confirm path ────────────────────────────────────────────────────
        if (confirmToken) {
          const result = consumeToken(confirmToken, { definitionId: id, currentStrandedCount: totalStranded });
          if (!result.ok) {
            // Re-issue a fresh preview if the token expired or state drifted
            if (result.newPreviewNeeded) {
              const fresh = issueToken({
                definitionId:  id,
                parentId,
                definitionHash: hashDefinition(definition),
                strandedGroups,
                totalStranded,
              });
              return reply.code(200).send({
                status:        'requires_confirmation',
                reason:        result.reason,
                strandedActors: strandedGroups.map(g => ({ currentState: g.state, count: g.count })),
                safeActors:    (await findActorsByDefinition(parentId)).length - totalStranded,
                confirmToken:  fresh.token,
                expiresIn:     fresh.expiresIn,
                message:       `${totalStranded} actor(s) will be tagged needs_rescue. Include confirmToken to proceed.`,
              });
            }
            return reply.code(400).send({ error: result.reason });
          }
          // Token valid — fall through to storage, will tag stranded actors after write
        } else {
          // ── First PUT — no token yet: return preview ─────────────────────
          const safeActors = (await findActorsByDefinition(parentId)).length - totalStranded;
          const issued = issueToken({
            definitionId:  id,
            parentId,
            definitionHash: hashDefinition(definition),
            strandedGroups,
            totalStranded,
          });
          return reply.code(200).send({
            status:        'requires_confirmation',
            strandedActors: strandedGroups.map(g => ({
              currentState: g.state,
              count:        g.count,
            })),
            safeActors,
            confirmToken:  issued.token,
            expiresIn:     issued.expiresIn,
            warnings,       // include any machine warnings in the preview too
            message:
              `${totalStranded} actor(s) are in states that do not exist in the new definition ` +
              `(${strandedGroups.map(g => `"${g.state}" ×${g.count}`).join(', ')}). ` +
              `These actors will be tagged needs_rescue and will stop accepting events until a rescue ` +
              `deployment provides a forward path. ` +
              `Re-submit this request with the confirmToken field to proceed, ` +
              `or fix the definition to include the missing states.`,
          });
        }
      }
    }

    // ── Step 3: Store definition ─────────────────────────────────────────────
    let tStar = eng.clockTick();

    // prefix_hash answers: "which actors are eligible for this deployment?"
    //
    //   No historyPath (absent or empty array):
    //     0n = wildcard — all actors on the parent definition are eligible.
    //     The engine routes every actor to this child regardless of history.
    //
    //   historyPath provided (e.g. ['START', 'SUBMIT_INFO', 'PAY_FEE']):
    //     prefix_hash = the fingerprint an actor would have after processing
    //     exactly those events in that order.  Only actors whose history
    //     contains this prefix are eligible; others stay on the parent.
    //
    // The hash must be computed with computeHistoryHash (not computeHash) so
    // it mirrors exactly what actorWorker.updateFingerprint produces —
    // starting from FNV_OFFSET, chaining fnv1aUpdate per event, no per-step
    // fnv1aFinal.
    const prefixHash = hasHistoryPath
      ? fingerprintToBigInt(computeHistoryHash(historyPath))
      : 0n;

    // Embed _stateMapping and _historyPath in the stored JSON so they survive
    // across restarts and can be compared in the idempotency check on re-deploy.
    const hasContextTransform = contextTransform && typeof contextTransform === 'object' &&
                               Object.keys(contextTransform).length > 0;
    const definitionToStore = {
      ...definition,
      ...(stateMapping && Object.keys(stateMapping).length > 0 ? { _stateMapping: stateMapping } : {}),
      _historyPath: hasHistoryPath ? historyPath : null,
      _historyRegions: normalizedHistoryRegions,
      ...(hasContextTransform ? { _contextTransform: contextTransform } : {}),
    };

    // ── Pre-deploy registry validation ────────────────────────────────────────
    // Compile the definition before storing it. If any guard or action name
    // referenced by the definition is absent from the loaded implementation
    // registry, reject the deploy with 422 so the error surfaces at deploy
    // time rather than silently failing at runtime per event.
    // Skipped when no registry is loaded (e.g. tests that call the API without
    // a setup file) so existing workflows without a registry are unaffected.
    let _precompiledResult = null;
    const _globalRegistry = getGlobalRegistry();
    if (_globalRegistry) {
      try {
        const compileResult = compileMachine(definitionToStore);
        const { runtimeDef: _rtDef, ...compiledForValidation } = compileResult;
        const missing = validateDefinitionAgainstRegistry(compiledForValidation, _globalRegistry);
        if (missing.length > 0) {
          return reply.code(422).send({
            error: `Definition references guards/actions not registered in the implementation registry: ${missing.join(', ')}`,
            missing,
          });
        }
        _precompiledResult = compileResult;
      } catch (compileErr) {
        request.log.warn({ err: compileErr, definitionId: id }, 'pre-deploy compile failed; skipping registry validation');
      }
    }

    // Refinement path: definition already exists but stateMapping changed.
    // Re-use the original t_star (deployedAt) so the changepoint location stays the same;
    // the engine updates r_max on the existing entry when we re-register below.
    const isRefinement = existing != null;
    if (isRefinement) {
      tStar = BigInt(existing.deployedAt);
      await updateDefinitionJson(id, definitionToStore);
    } else {
      try {
        await createDefinition({
          id,
          parentId:       parentId ?? null,
          definitionJson: definitionToStore,
          deployedAt:     Number(tStar),
        });
      } catch (err) {
        if (err.message?.includes('UNIQUE')) {
          return reply.code(200).send({ id, idempotent: true });
        }
        throw err;
      }
    }

    // Save compiled form — reuse the pre-compiled result from registry validation
    // if available, otherwise compile now (registry absent path).
    // Propagate failures: a NULL compiled_json means all subsequent sendEvents fail.
    const { runtimeDef, ...compiledForm } = _precompiledResult ?? compileMachine(definitionToStore);
    await updateCompiledJson(id, compiledForm);
    if (Object.keys(compiledForm.afterTransitions).length > 0) {
      await updateDefinitionJson(id, runtimeDef);
    }

    if (hasHistoryRegions) {
      // Parallel changepoint: register per-region hashes with the engine.
      // We do NOT insert into the scalar changepoints table — prefixHash would
      // be 0n (wildcard), routing every actor to this definition on restart.
      const regionHexMap   = computeRegionHashes(normalizedHistoryRegions);
      const regionArr      = regionFingerprintsToArray(regionHexMap);
      if (regionArr && regionArr.length > 0) {
        // Engine call first: need its return code to reject ambiguous selectors (-2).
        // If insertParChangepoint then fails, the in-memory engine entry is already
        // registered, but on next restart the DB re-seeds the engine from the DB
        // changepointpar table — so divergence is limited to the current process lifetime.
        const rc = eng.registerChangepointParallel(tStar, regionArr, BigInt(refinement), id);
        if (rc === -2) {
          // Engine rejected this selector as ambiguous (Proposition 5.14 violation).
          // The definition row was already written to DB; without a matching changepoint
          // it is inert — no actors will be migrated to it. Deploy under a different
          // version ID or adjust the selector to resolve the conflict.
          return reply.code(409).send({
            error: 'Ambiguous deployment: this historyRegions selector conflicts with an existing changepoint at the same deployment tick. Ensure selectors are pairwise incompatible or use a covering union selector (Proposition 5.14).',
          });
        }
        await insertParChangepoint({ tStar: Number(tStar), regionHashesHexMap: regionHexMap, refinement, childDefId: id });
      }
    } else {
      // DB first so that if the engine call below throws, the changepoint is already
      // persisted and will be re-loaded into the engine on next server restart.
      await insertChangepoint({ tStar: Number(tStar), prefixHash: prefixHash.toString(), refinement, childDefId: id });
      eng.registerChangepoint(tStar, prefixHash, BigInt(refinement), id);
    }

    // Invalidate inline migration + definition cache for the parent definition
    if (parentId) {
      try { invalidateMigrationCacheForDefinition(parentId); } catch {}
      try { invalidateDefinitionCache(parentId); } catch {}
    }
    // Invalidate cache for the newly deployed definition (fresh writes must be readable immediately)
    try { invalidateDefinitionCache(id); } catch {}

    // ── Step 4: Tag stranded actors needs_rescue (only reached after confirm) ─
    let strandedTagged = 0;
    if (parentId && confirmToken) {
      const strandedGroups   = await findStrandedActors(parentId, effectiveValidStates);
      const strandedActorIds = strandedGroups.flatMap(g => g.actorIds);
      if (strandedActorIds.length > 0) {
        await bulkTagNeedsRescue(strandedActorIds);
        evictFromHotRegistry(...strandedActorIds);
        strandedTagged = strandedActorIds.length;
        request.log.info(`[definitions] Tagged ${strandedTagged} actors as needs_rescue after deploying ${id}`);
      }
    }

    // ── Step 5: Enqueue migration jobs for safe actors ───────────────────────
    let deploymentId  = null;
    let affectedCount = 0;

    if (parentId) {
      const currentTick = eng.clockTick();
      // Migrate all active actors across the full machine family (all versions)
      const actors = await findActorsByMachine(machineId);

      if (actors.length > 0) {
        // Build the job list: only actors whose fingerprint matches the scalar
        // historyPath or parallel historyRegions selector. Wildcard deployments
        // enqueue every active actor in the machine family.
        // Limiting the count prevents checkDeploymentComplete from getting stuck when
        // actors don't match and are never migrated.
        const pendingJobs = [];

        if (!hasHistoryTarget) {
          // Wildcard deploy: C engine treats prefix_hash=0 as exact match against empty
          // fingerprint, not as "match all".  Bypass the engine and enqueue every active
          // actor on the machine directly.
          for (const actor of actors) {
            pendingJobs.push({ actor_id: actor.id, target_def_id: id });
          }
          const wildcardThreshold = parseInt(process.env.STATEKEEP_WILDCARD_WARN_THRESHOLD ?? '10000', 10);
          if (pendingJobs.length > wildcardThreshold) {
            warnings.push({
              code:    'LARGE_WILDCARD_DEPLOY',
              message: `Wildcard deployment will migrate ${pendingJobs.length} actors (threshold: ${wildcardThreshold}). ` +
                       `This may take several minutes. Use historyPath or historyRegions to target a subset of actors.`,
            });
          }
        } else {
          for (const actor of actors) {
            let targetDefId = null;
            try {
              const actorPrefixHash   = fingerprintToBigInt(actor.historyFingerprint);
              const actorCurrentDef   = await findDefinitionById(actor.definitionId);
              const currentDeployedAt = actorCurrentDef?.deployedAt ?? 0;
              const logicalStartTick  = actor.logicalStartTick ?? 0;

              const logicalTime = currentDeployedAt > logicalStartTick
                ? BigInt(currentDeployedAt) + 1n
                : BigInt(logicalStartTick);

              targetDefId = eng.computeAccessible(actorPrefixHash, logicalTime, currentTick);

              // Parallel path: check per-region fingerprints when scalar found nothing
              if (!targetDefId && actor.regionFingerprints) {
                const regionArr = regionFingerprintsToArray(actor.regionFingerprints);
                if (regionArr && regionArr.length > 0) {
                  targetDefId = eng.computeAccessibleParallel(regionArr, logicalTime, currentTick);
                }
              }
            } catch (e) {
              request.log.warn(`[definitions] computeAccessible failed for ${actor.id}: ${e.message}`);
            }
            if (targetDefId && targetDefId !== actor.definitionId) {
              pendingJobs.push({ actor_id: actor.id, target_def_id: targetDefId });
            }
          }
        }

        deploymentId = await createDeployment({ definitionId: id, affectedActors: pendingJobs.length });
        affectedCount = pendingJobs.length;

        if (pendingJobs.length > 0) {
          const jobs = pendingJobs.map(j => ({ ...j, deployment_id: deploymentId }));
          await enqueueJobs(jobs);
          await updateDeploymentStatus(deploymentId, 'migrating');
        } else {
          await updateDeploymentStatus(deploymentId, 'complete');
        }
      }
    }

    const code = warnings.length > 0 ? 201 : 201;
    return reply.code(code).send({
      id,
      parentId:        parentId ?? null,
      deployedAt:      Number(tStar),
      deploymentId,
      affectedActors:  affectedCount,
      strandedTagged,
      engineAvailable: eng.available,
      idempotent:      false,
      warnings,        // soft warnings included even on success
    });
  });

  // ── GET /v1/definitions/:id/status ────────────────────────────────────────
  fastify.get('/v1/definitions/:id/status', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const def = await findDefinitionById(id);
    if (!def) return reply.code(404).send({ error: `Definition ${id} not found` });
    const deployments = await findDeploymentsByDefinition(id);
    return reply.send({
      definition: { id: def.id, parentId: def.parentId, deployedAt: def.deployedAt, status: def.status },
      deployments,
    });
  });

  // ── GET /v1/definitions/:id/diff ──────────────────────────────────────────
  fastify.get('/v1/definitions/:id/diff', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const def = await findDefinitionById(id);
    if (!def) return reply.code(404).send({ error: `Definition ${id} not found` });
    if (!def.parentId) {
      return reply.send({ id, parentId: null, diff: null, message: 'No parent — this is a root definition.' });
    }
    const parent = await findDefinitionById(def.parentId);
    if (!parent) return reply.code(404).send({ error: `Parent definition ${def.parentId} not found` });

    const childStates  = Object.keys(def.definitionJson.states   ?? {});
    const parentStates = Object.keys(parent.definitionJson.states ?? {});
    const added        = childStates.filter(s => !parentStates.includes(s));
    const removed      = parentStates.filter(s => !childStates.includes(s));
    const common       = childStates.filter(s => parentStates.includes(s));

    const transitionsChanged = [];
    for (const state of common) {
      const childOn  = JSON.stringify(def.definitionJson.states[state]?.on    ?? {});
      const parentOn = JSON.stringify(parent.definitionJson.states[state]?.on ?? {});
      if (childOn !== parentOn) {
        transitionsChanged.push({
          state,
          from: parent.definitionJson.states[state]?.on ?? {},
          to:   def.definitionJson.states[state]?.on    ?? {},
        });
      }
    }

    const initialChanged = def.definitionJson.initial !== parent.definitionJson.initial;

    return reply.send({
      id,
      parentId: def.parentId,
      diff: {
        statesAdded:         added,
        statesRemoved:       removed,
        transitionsChanged,
        initialChanged,
        initialFrom:   initialChanged ? parent.definitionJson.initial : null,
        initialTo:     initialChanged ? def.definitionJson.initial    : null,
        stateMapping:  def.definitionJson._stateMapping ?? null,
      },
    });
  });

  // ── GET /v1/definitions/:id/stats ────────────────────────────────────────
  fastify.get('/v1/definitions/:id/stats', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const def = await findDefinitionById(id);
    if (!def) return reply.code(404).send({ error: `Definition ${id} not found` });

    let rows;
    if (isPostgres) {
      const { queryAll } = await import('../../registry/db-postgres.js');
      rows = await queryAll(
        `SELECT state_value, COUNT(*) as cnt FROM actors WHERE definition_id=$1 AND status='active' GROUP BY state_value`,
        [id]
      );
    } else {
      rows = getDb().prepare(`
        SELECT state_value, COUNT(*) as cnt FROM actors
        WHERE definition_id = ? AND status = 'active' GROUP BY state_value
      `).all(id);
    }

    const byState   = {};
    let totalActive = 0;
    for (const row of rows) {
      let sv;
      try { sv = row.state_value ? JSON.parse(row.state_value) : null; } catch { sv = row.state_value; }
      const key = typeof sv === 'string' ? sv : JSON.stringify(sv);
      byState[key] = Number(row.cnt);
      totalActive += Number(row.cnt);
    }

    return reply.send({ definitionId: id, totalActive, byState });
  });

  // ── POST /v1/definitions/preview ─────────────────────────────────────────
  fastify.post('/v1/definitions/preview', {
    schema: {
      body: {
        type: 'object',
        required: ['parentId', 'definition'],
        properties: {
          parentId:    { type: 'string' },
          definition:  { type: 'object' },
          historyPath: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const { parentId, definition, historyPath } = request.body;
    const eng = getEngine();

    const { errors, warnings } = analyseDefinition(definition);
    if (errors.length > 0) {
      return reply.code(400).send({ valid: false, wouldDeploy: false, errors, warnings });
    }

    const parentDef = parentId ? await findDefinitionById(parentId) : null;
    const previewMachineId = parentDef?.machineId ?? parentId;

    const dryRunTick = eng.clockTick();
    let migration = { eligible: 0, wouldMigrate: [], wouldStay: [], engineAvailable: eng.available };

    if (previewMachineId && eng.available) {
      const candidates = await evaluateMigrationCandidates(previewMachineId, eng, dryRunTick);
      migration = { ...candidates, engineAvailable: true };
    } else if (previewMachineId) {
      const actors = await findActorsByMachine(previewMachineId);
      migration = {
        eligible:        actors.length,
        wouldMigrate:    [],
        wouldStay:       actors.map(a => ({ actorId: a.id, currentState: a.stateValue, definitionId: a.definitionId, reason: 'engine_unavailable' })),
        engineAvailable: false,
        note:            'APV engine unavailable — build WASM with `make wasm -C src/ffi` or set STATEKEEP_ENGINE_PATH.',
      };
    }

    // Log preview decisions to migration_decisions (best-effort)
    const tick = Number(dryRunTick);
    const { logDecision } = await import('../../registry/jobRepo.js');
    for (const entry of migration.wouldMigrate) {
      logDecision({ actorId: entry.actorId, trigger: 'preview', evaluatedAt: tick, decision: 'migrated', reason: 'fingerprint_match', fromDefinitionId: parentId, toDefinitionId: entry.targetDefinitionId, actorFingerprint: '0', prefixHash: '0' }).catch(() => {});
    }
    for (const entry of migration.wouldStay) {
      logDecision({ actorId: entry.actorId, trigger: 'preview', evaluatedAt: tick, decision: 'stayed', reason: entry.reason ?? 'fingerprint_mismatch', fromDefinitionId: parentId, toDefinitionId: null, actorFingerprint: '0', prefixHash: '0' }).catch(() => {});
    }

    const newStateNames  = Object.keys(definition.states ?? {});
    const strandedGroups = await findStrandedActors(parentId, newStateNames);
    const strandedActors = strandedGroups.map(g => ({ currentState: g.state, count: g.count }));

    return reply.code(200).send({
      dryRun:         true,
      valid:          true,
      warnings,
      wouldDeploy:    strandedActors.length === 0,
      strandedActors,
      migration,
    });
  });

  // ── GET /v1/machines/:id/stats ────────────────────────────────────────────
  fastify.get('/v1/machines/:id/stats', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params;

    // id is the machineId (root definition id)
    const definitions = await findDefinitionsByMachine(id);
    if (definitions.length === 0) {
      return reply.code(404).send({ error: `Machine ${id} not found` });
    }

    // Per-version actor counts and state breakdown
    const versions = await Promise.all(definitions.map(async def => {
      let rows;
      if (isPostgres) {
        const { queryAll } = await import('../../registry/db-postgres.js');
        rows = await queryAll(
          `SELECT state_value, COUNT(*) as cnt FROM actors WHERE definition_id=$1 AND status='active' GROUP BY state_value`,
          [def.id]
        );
      } else {
        rows = getDb().prepare(`
          SELECT state_value, COUNT(*) as cnt FROM actors WHERE definition_id = ? AND status = 'active' GROUP BY state_value
        `).all(def.id);
      }
      const byState   = {};
      let totalActive = 0;
      for (const row of rows) {
        let sv;
        try { sv = row.state_value ? JSON.parse(row.state_value) : null; } catch { sv = row.state_value; }
        const key = typeof sv === 'string' ? sv : JSON.stringify(sv);
        byState[key] = Number(row.cnt);
        totalActive += Number(row.cnt);
      }
      return {
        definitionId: def.id,
        parentId:     def.parentId,
        deployedAt:   def.deployedAt,
        createdAt:    def.createdAt,
        status:       def.status,
        activeActors: totalActive,
        byState,
      };
    }));

    const totalActive = versions.reduce((s, v) => s + v.activeActors, 0);

    // Aggregate needs_rescue + terminated counts across all versions
    let summary;
    if (isPostgres) {
      const { queryAll } = await import('../../registry/db-postgres.js');
      summary = await queryAll(
        `SELECT status, COUNT(*) as cnt FROM actors WHERE definition_id IN (SELECT id FROM definitions WHERE machine_id=$1) GROUP BY status`,
        [id]
      );
    } else {
      summary = getDb().prepare(`
        SELECT status, COUNT(*) as cnt FROM actors WHERE definition_id IN (SELECT id FROM definitions WHERE machine_id = ?) GROUP BY status
      `).all(id);
    }
    const byStatus = {};
    for (const r of summary) byStatus[r.status] = Number(r.cnt);

    return reply.send({
      machineId:    id,
      totalActive,
      byStatus,
      versions,
    });
  });

  // ── GET /v1/deployments/:id/decisions ────────────────────────────────────
  fastify.get('/v1/deployments/:id/decisions', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      querystring: {
        type: 'object',
        properties: {
          limit:  { type: 'integer', default: 100, minimum: 1, maximum: 500 },
          offset: { type: 'integer', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { limit, offset } = request.query;

    try {
      // Verify deployment exists and belongs to this org before returning any data
      let deployment;
      if (isPostgres) {
        const { queryOne } = await import('../../registry/db-postgres.js');
        deployment = await queryOne(`SELECT id FROM deployments WHERE id=$1`, [id]);
      } else {
        deployment = getDb().prepare(`SELECT id FROM deployments WHERE id = ?`).get(id);
      }
      if (!deployment) return reply.code(404).send({ error: `Deployment ${id} not found` });

      const rows = await findDecisionsByDeployment(id, { limit, offset });

      let total;
      if (isPostgres) {
        const { queryOne } = await import('../../registry/db-postgres.js');
        total = Number((await queryOne(`SELECT COUNT(*) as cnt FROM migration_decisions WHERE deployment_id=$1`, [id]))?.cnt ?? 0);
      } else {
        total = getDb().prepare(`SELECT COUNT(*) as cnt FROM migration_decisions WHERE deployment_id = ?`).get(id)?.cnt ?? 0;
      }

      const decisions = rows.map(r => ({
        id:               r.id,
        actorId:          r.actor_id,
        trigger:          r.trigger,
        evaluatedAt:      r.evaluated_at,
        decision:         r.decision,
        reason:           r.reason,
        fromDefinitionId: r.from_definition_id,
        toDefinitionId:   r.to_definition_id,
        actorFingerprint: r.actor_fingerprint,
        prefixHash:       r.prefix_hash,
        createdAt:        r.created_at,
      }));

      return reply.send({ deploymentId: id, decisions, total, limit, offset });
    } catch (err) {
      request.log.error(err, `[deployments] decisions query failed for ${id}`);
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── GET /v1/definitions/:id ───────────────────────────────────────────────
  fastify.get('/v1/definitions/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const def = await findDefinitionById(request.params.id);
    if (!def) {
      return reply.code(404).send({ error: `Definition ${request.params.id} not found` });
    }
    return reply.send(def);
  });

  // ── DELETE /v1/definitions/:id ────────────────────────────────────────────
  fastify.delete('/v1/definitions/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const def = await findDefinitionById(request.params.id);
    if (!def) {
      return reply.code(404).send({ error: `Definition ${request.params.id} not found` });
    }
    await deprecateDefinition(request.params.id);
    return reply.code(200).send({ id: request.params.id, status: 'deprecated' });
  });

  // ── GET /v1/definitions ────────────────────────────────────────────────────
  fastify.get('/v1/definitions', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit:  { type: 'integer', default: 50 },
          offset: { type: 'integer', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const defs = await listDefinitions({ ...request.query });

    // One GROUP BY query — no N+1
    let countRows;
    if (isPostgres) {
      const { queryAll } = await import('../../registry/db-postgres.js');
      countRows = await queryAll(
        `SELECT definition_id, COUNT(*) as cnt FROM actors WHERE status IN ('active','migrating','needs_rescue') GROUP BY definition_id`
      );
    } else {
      countRows = getDb().prepare(`
        SELECT definition_id, COUNT(*) as cnt FROM actors WHERE status IN ('active','migrating','needs_rescue') GROUP BY definition_id
      `).all();
    }
    const countByDef = Object.fromEntries(countRows.map(r => [r.definition_id, Number(r.cnt)]));

    const definitions = defs.map(d => ({ ...d, _actorCount: countByDef[d.id] ?? 0 }));
    return reply.send({ definitions, count: definitions.length });
  });
}
