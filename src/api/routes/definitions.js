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
import { getDb }        from '../../registry/db.js';
import {
  findDefinitionById,
  createDefinition,
  updateDefinitionJson,
  listDefinitions,
  findDefinitionsByMachine,
  deprecateDefinition,
} from '../../registry/definitionRepo.js';
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
 * When hasHistoryPath = false (wildcard deploy), all active actors are returned
 * as wouldMigrate without calling the engine (engine uses exact prefix match,
 * not wildcard, for prefix_hash=0).
 */
function evaluateMigrationCandidates(machineId, orgId, eng, currentTick, hasHistoryPath = true) {
  const actors     = findActorsByMachine(machineId, orgId);
  const wouldMigrate = [];
  const wouldStay    = [];

  if (!hasHistoryPath) {
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
        },
      },
    },
  }, async (request, reply) => {
    const { id, parentId, definition, refinement = 1, confirmToken, historyPath, stateMapping, historyRegions } = request.body;
    const isDryRun       = request.query?.dryRun === 'true';
    const eng            = getEngine();
    const hasHistoryPath = Array.isArray(historyPath) && historyPath.length > 0;

    // ── Idempotency ──────────────────────────────────────────────────────────
    // A re-deploy of the same ID is idempotent only when historyPath AND
    // stateMapping both match. Changing either is a meaningful update (new
    // refinement) — not an error — so we fall through to create a new deployment.
    // Changing historyPath alone is still a 409 (user error: ambiguous changepoint).
    const existing = findDefinitionById(id);
    if (existing) {
      const normaliseHP  = (hp) => (Array.isArray(hp) && hp.length > 0) ? hp : null;
      const normaliseSM  = (sm) => (sm && Object.keys(sm).length > 0) ? sm : null;
      const incomingHP   = normaliseHP(historyPath);
      const storedHP     = normaliseHP(existing.definitionJson._historyPath);
      const incomingSM   = normaliseSM(stateMapping);
      const storedSM     = normaliseSM(existing.definitionJson._stateMapping);
      const historyChanged  = JSON.stringify(incomingHP) !== JSON.stringify(storedHP);
      const mappingChanged  = JSON.stringify(incomingSM) !== JSON.stringify(storedSM);

      if (historyChanged) {
        return reply.code(409).send({
          error:               `Definition ${id} already exists with a different historyPath. Deploy under a new version ID.`,
          existingHistoryPath: storedHP,
          incomingHistoryPath: incomingHP,
        });
      }

      // stateMapping changed → treat as a new refinement (fall through to deploy)
      if (!mappingChanged) {
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

    const orgId = request.orgId;

    // Resolve machineId for the full family scope (used in both dryRun and live paths)
    let machineId = id;
    if (parentId) {
      const parentDef = findDefinitionById(parentId);
      if (parentDef && parentDef.orgId !== orgId) {
        return reply.code(404).send({ error: `Definition ${parentId} not found` });
      }
      machineId = parentDef?.machineId ?? parentId;
    }

    // ── dryRun: evaluate without writing anything ──────────────────────────────
    if (isDryRun) {
      const dryRunTick = eng.clockTick();
      let migration = { eligible: 0, wouldMigrate: [], wouldStay: [], engineAvailable: eng.available };

      if (parentId && eng.available) {
        const candidates = evaluateMigrationCandidates(machineId, orgId, eng, dryRunTick, hasHistoryPath);
        migration = { ...candidates, engineAvailable: true };
      } else if (parentId) {
        const dryActors = findActorsByMachine(machineId, orgId);
        migration = {
          eligible:        dryActors.length,
          wouldMigrate:    [],
          wouldStay:       dryActors.map(a => ({ actorId: a.id, currentState: a.stateValue, definitionId: a.definitionId, reason: 'engine_unavailable' })),
          engineAvailable: false,
          note:            'APV engine not loaded — migration routing unavailable in fallback mode.',
        };
      }

      // Compute stranded actors for the dryRun preview
      let dryStrandedActors = [];
      if (parentId) {
        const strandedGroups = findStrandedActors(parentId, effectiveValidStates, orgId);
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
    if (parentId) {
      const strandedGroups = findStrandedActors(parentId, effectiveValidStates, orgId);
      const totalStranded  = strandedGroups.reduce((s, g) => s + g.count, 0);

      if (totalStranded > 0) {
        // ── Confirm path ────────────────────────────────────────────────────
        if (confirmToken) {
          const result = consumeToken(confirmToken, { definitionId: id, currentStrandedCount: totalStranded, orgId });
          if (!result.ok) {
            // Re-issue a fresh preview if the token expired or state drifted
            if (result.newPreviewNeeded) {
              const fresh = issueToken({
                definitionId:  id,
                parentId,
                orgId,
                definitionHash: hashDefinition(definition),
                strandedGroups,
                totalStranded,
              });
              return reply.code(200).send({
                status:        'requires_confirmation',
                reason:        result.reason,
                strandedActors: strandedGroups.map(g => ({ currentState: g.state, count: g.count })),
                safeActors:    findActorsByDefinition(parentId, orgId).length - totalStranded,
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
          const safeActors = findActorsByDefinition(parentId, orgId).length - totalStranded;
          const issued = issueToken({
            definitionId:  id,
            parentId,
            orgId,
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
    const tStar = eng.clockTick();

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
    const definitionToStore = {
      ...definition,
      ...(stateMapping && Object.keys(stateMapping).length > 0 ? { _stateMapping: stateMapping } : {}),
      _historyPath: hasHistoryPath ? historyPath : null,
    };

    // Refinement path: definition already exists but stateMapping changed.
    // Re-use the original t_star (deployedAt) so the changepoint location stays the same;
    // the engine updates r_max on the existing entry when we re-register below.
    const isRefinement = existing != null;
    if (isRefinement) {
      tStar = BigInt(existing.deployedAt);
      updateDefinitionJson(id, definitionToStore);
    } else {
      try {
        createDefinition({
          id,
          parentId:       parentId ?? null,
          orgId,
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

    try {
      const hasRegions = historyRegions && typeof historyRegions === 'object' &&
                         Object.keys(historyRegions).length > 0;
      if (hasRegions) {
        // Parallel changepoint: register per-region hashes with the engine.
        // We do NOT insert into the scalar changepoints table — prefixHash would
        // be 0n (wildcard), routing every actor to this definition on restart.
        const regionHexMap   = computeRegionHashes(historyRegions);
        const regionArr      = regionFingerprintsToArray(regionHexMap);
        const regionHexArr   = Object.values(regionHexMap);
        if (regionArr && regionArr.length > 0) {
          eng.registerChangepointParallel(tStar, regionArr, BigInt(refinement), id);
          insertParChangepoint({ orgId, tStar: Number(tStar), regionHashesHexArr: regionHexArr, refinement, childDefId: id });
        }
      } else {
        eng.registerChangepoint(tStar, prefixHash, BigInt(refinement), id);
        insertChangepoint({ orgId, tStar: Number(tStar), prefixHash: prefixHash.toString(), refinement, childDefId: id });
      }
    } catch (e) {
      request.log.warn(`[definitions] registerChangepoint failed: ${e.message}`);
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
      const strandedGroups   = findStrandedActors(parentId, effectiveValidStates, orgId);
      const strandedActorIds = strandedGroups.flatMap(g => g.actorIds);
      if (strandedActorIds.length > 0) {
        bulkTagNeedsRescue(strandedActorIds);
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
      const actors = findActorsByMachine(machineId, orgId);

      if (actors.length > 0) {
        // Build the job list: only actors whose fingerprint matches the historyPath prefix
        // (or ALL actors for wildcard deployments where hasHistoryPath = false).
        // Limiting the count prevents checkDeploymentComplete from getting stuck when
        // actors don't match and are never migrated.
        const pendingJobs = [];

        if (!hasHistoryPath) {
          // Wildcard deploy: C engine treats prefix_hash=0 as exact match against empty
          // fingerprint, not as "match all".  Bypass the engine and enqueue every active
          // actor on the machine directly.
          for (const actor of actors) {
            pendingJobs.push({ actor_id: actor.id, org_id: orgId, target_def_id: id });
          }
        } else {
          for (const actor of actors) {
            let targetDefId = null;
            try {
              const actorPrefixHash   = fingerprintToBigInt(actor.historyFingerprint);
              const actorCurrentDef   = findDefinitionById(actor.definitionId);
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
              pendingJobs.push({ actor_id: actor.id, org_id: orgId, target_def_id: targetDefId });
            }
          }
        }

        deploymentId = createDeployment({ definitionId: id, affectedActors: pendingJobs.length, orgId });
        affectedCount = pendingJobs.length;

        if (pendingJobs.length > 0) {
          const jobs = pendingJobs.map(j => ({ ...j, deployment_id: deploymentId }));
          enqueueJobs(jobs);
          updateDeploymentStatus(deploymentId, 'migrating');
        } else {
          updateDeploymentStatus(deploymentId, 'complete');
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
    const def = findDefinitionById(id);
    if (!def || def.orgId !== request.orgId) return reply.code(404).send({ error: `Definition ${id} not found` });
    const deployments = findDeploymentsByDefinition(id);
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
    const def = findDefinitionById(id);
    if (!def || def.orgId !== request.orgId) return reply.code(404).send({ error: `Definition ${id} not found` });
    if (!def.parentId) {
      return reply.send({ id, parentId: null, diff: null, message: 'No parent — this is a root definition.' });
    }
    const parent = findDefinitionById(def.parentId);
    if (!parent || parent.orgId !== request.orgId) return reply.code(404).send({ error: `Parent definition ${def.parentId} not found` });

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
    const def = findDefinitionById(id);
    if (!def || def.orgId !== request.orgId) return reply.code(404).send({ error: `Definition ${id} not found` });

    const db   = getDb();
    const rows = db.prepare(`
      SELECT state_value, COUNT(*) as cnt
      FROM actors
      WHERE definition_id = ? AND status = 'active'
      GROUP BY state_value
    `).all(id);

    const byState   = {};
    let totalActive = 0;
    for (const row of rows) {
      let sv;
      try { sv = row.state_value ? JSON.parse(row.state_value) : null; } catch { sv = row.state_value; }
      const key = typeof sv === 'string' ? sv : JSON.stringify(sv);
      byState[key] = row.cnt;
      totalActive += row.cnt;
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
    const previewOrgId = request.orgId;
    const eng = getEngine();

    const { errors, warnings } = analyseDefinition(definition);
    if (errors.length > 0) {
      return reply.code(400).send({ valid: false, wouldDeploy: false, errors, warnings });
    }

    const parentDef = parentId ? findDefinitionById(parentId) : null;
    if (parentDef && parentDef.orgId !== previewOrgId) {
      return reply.code(404).send({ error: `Definition ${parentId} not found` });
    }
    const previewMachineId = parentDef?.machineId ?? parentId;

    const dryRunTick = eng.clockTick();
    let migration = { eligible: 0, wouldMigrate: [], wouldStay: [], engineAvailable: eng.available };

    if (previewMachineId && eng.available) {
      const candidates = evaluateMigrationCandidates(previewMachineId, previewOrgId, eng, dryRunTick);
      migration = { ...candidates, engineAvailable: true };
    } else if (previewMachineId) {
      const actors = findActorsByMachine(previewMachineId, previewOrgId);
      migration = {
        eligible:        actors.length,
        wouldMigrate:    [],
        wouldStay:       actors.map(a => ({ actorId: a.id, currentState: a.stateValue, definitionId: a.definitionId, reason: 'engine_unavailable' })),
        engineAvailable: false,
        note:            'APV engine not loaded — migration routing unavailable in fallback mode.',
      };
    }

    // Log preview decisions to migration_decisions
    const db   = getDb();
    const tick  = Number(dryRunTick);
    for (const entry of migration.wouldMigrate) {
      try {
        db.prepare(`
          INSERT INTO migration_decisions
            (actor_id, org_id, deployment_id, trigger, evaluated_at, decision, reason,
             from_definition_id, to_definition_id, actor_fingerprint, prefix_hash, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          entry.actorId, previewOrgId, null, 'preview', tick,
          'migrated', 'fingerprint_match',
          parentId, entry.targetDefinitionId,
          '0', '0', Date.now()
        );
      } catch {}
    }
    for (const entry of migration.wouldStay) {
      try {
        db.prepare(`
          INSERT INTO migration_decisions
            (actor_id, org_id, deployment_id, trigger, evaluated_at, decision, reason,
             from_definition_id, to_definition_id, actor_fingerprint, prefix_hash, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          entry.actorId, previewOrgId, null, 'preview', tick,
          'stayed', entry.reason ?? 'fingerprint_mismatch',
          parentId, null,
          '0', '0', Date.now()
        );
      } catch {}
    }

    const newStateNames  = Object.keys(definition.states ?? {});
    const strandedGroups = findStrandedActors(parentId, newStateNames, previewOrgId);
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
    const definitions = findDefinitionsByMachine(id, request.orgId);
    if (definitions.length === 0) {
      return reply.code(404).send({ error: `Machine ${id} not found` });
    }

    const db = getDb();

    // Per-version actor counts and state breakdown
    const versions = definitions.map(def => {
      const rows = db.prepare(`
        SELECT state_value, COUNT(*) as cnt
        FROM actors
        WHERE definition_id = ? AND status = 'active'
        GROUP BY state_value
      `).all(def.id);

      const byState   = {};
      let totalActive = 0;
      for (const row of rows) {
        let sv;
        try { sv = row.state_value ? JSON.parse(row.state_value) : null; } catch { sv = row.state_value; }
        const key = typeof sv === 'string' ? sv : JSON.stringify(sv);
        byState[key] = row.cnt;
        totalActive += row.cnt;
      }
      return {
        definitionId: def.id,
        parentId:     def.parentId,
        deployedAt:   def.deployedAt,
        status:       def.status,
        activeActors: totalActive,
        byState,
      };
    });

    const totalActive = versions.reduce((s, v) => s + v.activeActors, 0);

    // Aggregate needs_rescue + terminated counts across all versions
    const summary = db.prepare(`
      SELECT status, COUNT(*) as cnt FROM actors
      WHERE definition_id IN (
        SELECT id FROM definitions WHERE machine_id = ?
      )
      GROUP BY status
    `).all(id);
    const byStatus = {};
    for (const r of summary) byStatus[r.status] = r.cnt;

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
      const rows = findDecisionsByDeployment(id, { limit, offset });
      if (rows.length === 0) {
        // Check if deployment actually exists
        const exists = getDb().prepare(`SELECT id FROM deployments WHERE id = ?`).get(id);
        if (!exists) return reply.code(404).send({ error: `Deployment ${id} not found` });
      }

      const total = getDb()
        .prepare(`SELECT COUNT(*) as cnt FROM migration_decisions WHERE deployment_id = ?`)
        .get(id)?.cnt ?? 0;

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
    const def = findDefinitionById(request.params.id);
    if (!def || def.orgId !== request.orgId) {
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
    const def = findDefinitionById(request.params.id);
    if (!def || def.orgId !== request.orgId) {
      return reply.code(404).send({ error: `Definition ${request.params.id} not found` });
    }
    deprecateDefinition(request.params.id);
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
    const defs = listDefinitions({ ...request.query, orgId: request.orgId });
    return reply.send({ definitions: defs, count: defs.length });
  });
}
