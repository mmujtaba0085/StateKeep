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
import { withRemote, remoteEnabled, refreshRemoteManifest } from '../../runtime/remoteImplementations.js';
import { conditionGuard } from '../../runtime/conditionGuards.js';
import {
  findDeploymentsByDefinition,
  createDeployment,
  updateDeploymentStatus,
} from '../../registry/deploymentRepo.js';
import {
  findActorsByDefinition,
  findActorsByMachine,
  findStrandedActors,
  findStrandedActorsForDeploy,
} from '../../registry/actorRepo.js';
import { enqueueJobs, findDecisionsByDeployment } from '../../registry/jobRepo.js';
import { nextDeployTick, withFamilyDeployLock } from '../../registry/deployClock.js';
import { getEngine, scopeOf }         from '../../ffi/engine.js';
import { invalidateMigrationCacheForDefinition, evictFromHotRegistry, invalidateDefinitionCache } from '../../runtime/actorManager.js';
import { computeHistoryHash, fingerprintToBigInt, computeRegionHashes, regionFingerprintsToArray } from '../../ffi/hashUtils.js';
import { analyseDefinition }          from '../lib/staticAnalysis.js';
import { issueToken, consumeToken }   from '../../registry/confirmTokenStore.js';
import { insertChangepoint, insertParChangepoint } from '../../registry/changepointRepo.js';
import { normalizeHistoryRegions } from '../../runtime/statePaths.js';
import { getWriteBuffer } from '../../runtime/writeBuffer.js';
import { isSafeContextPath } from '../../runtime/actorWorker.js';
import { registerScalar, registerParallel, normalizeHistoryPath } from '../../runtime/routingRegistry.js';
import { predictRouting, lateMatcherRisk } from '../../runtime/deployAnalysis.js';
import { fingerprintMatchesPath } from '../../ffi/fingerprintChain.js';
import {
  routeTargetFor, markChangepointRowRegistered, syncChangepointsFromDb,
} from '../../runtime/actorManager.js';
import { publishRegistryChange, awaitRegistryBarrier } from '../../cluster/cluster.js';

// A placeholder time later than every registered change-point: the candidate deployment
// is always the family's newest.
const CANDIDATE_T = 9_007_199_254_740_000n;

/** Group predicted strandings for the confirmation preview. */
function strandedGroupsOf(analysis, scopeCount) {
  const groups = new Map();
  for (const s of analysis.stranded) {
    const key = `${s.atVersion}|${typeof s.state === 'string' ? s.state : JSON.stringify(s.state)}`;
    const g = groups.get(key) ?? { state: typeof s.state === 'string' ? s.state : JSON.stringify(s.state),
      atVersion: s.atVersion, reason: s.reason, count: 0, actorIds: [] };
    g.count++; g.actorIds.push(s.actorId);
    groups.set(key, g);
  }
  const out = [...groups.values()];
  out.scope = scopeCount;
  return out;
}

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
async function evaluateMigrationCandidates(machineId, eng, currentTick, { prefixHash = null, hasHistoryRegions = false } = {}) {
  // Predicts what a deploy WOULD do. The new definition's change-point is not
  // registered yet, so asking the engine (as this used to) always answered
  // "nobody moves". Mirror the deploy logic directly instead:
  //   wildcard (no historyPath) → every active actor in the family migrates
  //   historyPath               → actors whose current fingerprint equals the
  //                               path's prefix hash (what the engine matches)
  const actors       = await findActorsByMachine(machineId);
  const wouldMigrate = [];
  const wouldStay    = [];

  for (const actor of actors) {
    let migrates;
    let reason = 'fingerprint_mismatch';
    if (hasHistoryRegions) {
      migrates = false;
      reason   = 'parallel_regions_not_previewable';
    } else if (prefixHash === null) {
      migrates = true;
    } else {
      try { migrates = fingerprintMatchesPath(actor.historyFingerprint, prefixHash); }
      catch { migrates = false; }
    }
    const entry = { actorId: actor.id, currentState: actor.stateValue, definitionId: actor.definitionId };
    if (migrates) wouldMigrate.push({ ...entry, targetDefinitionId: null /* not stored yet */ });
    else          wouldStay.push({ ...entry, reason });
  }

  return {
    eligible: actors.length, wouldMigrate, wouldStay, engineAvailable: eng.available,
    ...(hasHistoryRegions ? { note: 'historyRegions (parallel) targeting cannot be previewed; wouldMigrate is not computed.' } : {}),
  };
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
            items:       {
              anyOf: [
                { type: 'string', minLength: 1 },
                { type: 'object', required: ['after', 'ms'],
                  properties: { after: { type: 'string', minLength: 1 }, ms: { type: 'integer', minimum: 0 } },
                  additionalProperties: false },
              ],
            },
            description: 'Ordered list of event types that an actor must have processed ' +
                         'to be eligible for this deployment. Absent or empty = wildcard (all actors). ' +
                         'A delayed (after:) transition is written { "after": "<state path>", "ms": <delay> }.',
          },
          stateMapping: {
            type:        'object',
            description: 'Maps old states to new states for actors that migrate. Keys and values are ' +
                         'state paths ("review" or "shipping.packing"); the longest matching key wins.',
            additionalProperties: { type: 'string' },
          },
          historyRegions: {
            type:        'object',
            description: 'Parallel region fingerprint selectors. Keys are region names, values are ' +
                         'ordered event-type arrays. All regions must match (AND composition). ' +
                         'Targets actors on parallel XState machines. Mutually exclusive with historyPath.',
            additionalProperties: { type: 'array', items: {
              anyOf: [
                { type: 'string' },
                { type: 'object', required: ['after', 'ms'],
                  properties: { after: { type: 'string' }, ms: { type: 'integer', minimum: 0 } },
                  additionalProperties: false },
              ],
            } },
          },
          contextTransform: {
            type:        'object',
            description: 'New context field paths (dot-notation) and where their value comes from: ' +
                         'an old path ("feePaid"), a constant ({ "value": 0 }) or an old path with a ' +
                         'default ({ "from": "fee", "default": 0 }). Old fields are preserved (additive).',
            additionalProperties: {
              anyOf: [
                { type: 'string' },
                { type: 'object', properties: { value: {}, from: { type: 'string' }, default: {} }, additionalProperties: false },
              ],
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    // Deployments of one workflow are serialized (deployClock.js): their times are then
    // committed in order, which the completeness of routing relies on.
    const { id: _id, parentId: _parentId } = request.body;
    let family = _id;
    if (_parentId) family = (await findDefinitionById(_parentId))?.machineId ?? _parentId;
    return withFamilyDeployLock(family, () => deployDefinitionHandler(request, reply));
  });

  async function deployDefinitionHandler(request, reply) {
    const { id, parentId, definition, refinement = 1, confirmToken, stateMapping, contextTransform } = request.body;
    // A delayed transition may be written { after: 'state.path', ms } in a history pattern.
    const historyPath    = normalizeHistoryPath(request.body.historyPath);
    const historyRegions = request.body.historyRegions && typeof request.body.historyRegions === 'object'
      ? Object.fromEntries(Object.entries(request.body.historyRegions).map(([k, v]) => [k, normalizeHistoryPath(v)]))
      : request.body.historyRegions;
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
      // (_sourceHash: the stored JSON can be rewritten by compilation, e.g. after: timers)
      // Rows written before _sourceHash existed may hold the compiled form (after: timers
      // rewritten); compare against that too before calling the definition changed.
      const stripInternal = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !k.startsWith('_')));
      const sameAsCompiled = () => {
        try { return JSON.stringify(stripInternal(compileMachine(definition).runtimeDef)) === JSON.stringify(storedDefClean); }
        catch { return false; }
      };
      const definitionChanged = existing.definitionJson._sourceHash
        ? existing.definitionJson._sourceHash !== hashDefinition(definition)
        : JSON.stringify(definition) !== JSON.stringify(storedDefClean) && !sameAsCompiled();

      if (historyChanged) {
        return reply.code(409).send({
          error:               `Definition ${id} already exists with different history targeting. Deploy under a new version ID.`,
          existingHistoryPath: storedHP,
          incomingHistoryPath: incomingHP,
          existingHistoryRegions: storedHR,
          incomingHistoryRegions: incomingHR,
        });
      }

      // Versions are immutable. Editing one in place changed the behaviour of actors
      // already on it without a migration (and outside every guarantee of the routing
      // model). A changed definition, state mapping or context transform is a new version.
      const transformChanged = JSON.stringify(contextTransform && Object.keys(contextTransform).length ? contextTransform : null) !==
                               JSON.stringify(existing.definitionJson._contextTransform ?? null);
      if (mappingChanged || definitionChanged || transformChanged) {
        return reply.code(409).send({
          error: `Definition ${id} already exists and versions are immutable. Deploy the change under a new version ID ` +
                 `(with parentId '${id}' to move its actors).`,
          code:  'VERSION_IMMUTABLE',
        });
      }
      {
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

    // contextTransform paths are applied with dot-notation writes — reject any path
    // that could reach Object.prototype ('__proto__', 'constructor', 'prototype').
    if (contextTransform !== undefined && contextTransform !== null) {
      if (typeof contextTransform !== 'object' || Array.isArray(contextTransform)) {
        return reply.code(400).send({ error: 'contextTransform must be an object of { "new.path": "old.path" | { value } | { from, default } }' });
      }
      for (const [to, spec] of Object.entries(contextTransform)) {
        const from = typeof spec === 'string' ? spec
          : (spec && typeof spec === 'object' && !Array.isArray(spec) && typeof spec.from === 'string') ? spec.from : null;
        const constant = spec && typeof spec === 'object' && !Array.isArray(spec) &&
          (Object.prototype.hasOwnProperty.call(spec, 'value') || Object.prototype.hasOwnProperty.call(spec, 'default'));
        if (!isSafeContextPath(to) || (from !== null && !isSafeContextPath(from)) || (from === null && !constant)) {
          return reply.code(400).send({ error: `contextTransform entry not allowed: '${to}'`, code: 'UNSAFE_CONTEXT_PATH' });
        }
      }
    }

    // historyPath is matched against an actor's history from its FIRST event (it is a
    // prefix, not a substring). A path like ['REQUEST_INFO','RESUBMIT'] on a machine that
    // starts with SUBMIT can never match anyone, and used to deploy "successfully" with
    // 0 affected actors. Reject it when the parent is simple enough to check reliably.
    if (hasHistoryPath) {
      const problem = checkHistoryPathWalkable(parentDefForTargeting?.definitionJson, historyPath);
      if (problem) {
        return reply.code(400).send({
          error: `historyPath can never match: ${problem}. historyPath must list events from the ` +
                 `actor's first event onward (it is matched as a prefix of the actor's history).`,
          code:  'HISTORY_PATH_UNREACHABLE',
        });
      }
    }

    // Resolve machineId for the full family scope (used in both dryRun and live paths)
    let machineId = id;
    if (parentId) {
      const parentDef = parentDefForTargeting;
      machineId = parentDef?.machineId ?? parentId;
    }

    // The stored version: the definition plus its routing and migration metadata.
    const hasContextTransform = contextTransform && typeof contextTransform === 'object' &&
                               Object.keys(contextTransform).length > 0;
    const definitionToStore = {
      ...definition,
      _sourceHash: hashDefinition(definition),
      ...(stateMapping && Object.keys(stateMapping).length > 0 ? { _stateMapping: stateMapping } : {}),
      _historyPath: hasHistoryPath ? historyPath : null,
      _historyRegions: normalizedHistoryRegions,
      ...(hasContextTransform ? { _contextTransform: contextTransform } : {}),
    };

    // ── What this deployment will do (deployAnalysis.js) ─────────────────────
    // Every routable actor of the family is routed, by the real rule and the real
    // mappings, through the family's pending deployments plus this one. Stranded
    // predictions ask for confirmation; late-matcher risks are reported as warnings.
    let analysis = null, lateRisk = [], familyActors = [];
    const analyse = async () => {
      if (!parentId) return;
      await getWriteBuffer().flush();                  // the latest actor states
      try { await syncChangepointsFromDb(); } catch {}  // deployments made through other servers
      familyActors = await findActorsByMachine(machineId);
      const candidate = {
        id, kind: hasHistoryRegions ? 'p' : 's', t: CANDIDATE_T,
        pattern: hasHistoryPath ? historyPath : null,
        historyRegions: normalizedHistoryRegions, definitionJson: definitionToStore,
      };
      const getDef = (defId) => findDefinitionById(defId);
      analysis = await predictRouting({ machineId, actors: familyActors, getDef, candidate });
      lateRisk = await lateMatcherRisk({ machineId, actors: familyActors, getDef, candidate });
    };
    const strandedNow = () => strandedGroupsOf(analysis ?? { stranded: [] }, familyActors.length);
    const lateWarnings = () => lateRisk.length === 0 ? [] : [{
      code: 'LATE_MATCHER_RISK',
      message: 'Actors that reach this history later could be in states this version cannot place ' +
               '(they would be stranded then): ' +
               lateRisk.map((r) => `${r.version}: ${[...r.states, ...(r.conflictingPairs ?? []).map((p) => p.join(' + '))].join(', ')}`).join('; ') +
               '. Add stateMapping entries for these states to rule it out.',
      versions: lateRisk,
    }];

    // ── dryRun: evaluate without writing anything ──────────────────────────────
    if (isDryRun) {
      await analyse();
      const dryStrandedActors = strandedNow().map(g => ({ currentState: g.state, atVersion: g.atVersion, count: g.count }));
      const migration = {
        eligible:     familyActors.length,
        wouldMigrate: (analysis?.moves ?? []).map((m) => ({ actorId: m.actorId, hops: m.hops })),
        wouldStay:    (analysis?.stays ?? []).map((m) => ({ actorId: m.actorId, hops: m.hops, reason: 'not_routed_through_this_version' })),
        engineAvailable: eng.available,
      };
      return reply.code(200).send({
        dryRun:         true,
        valid:          true,
        warnings:       [...warnings, ...lateWarnings()],
        wouldDeploy:    dryStrandedActors.length === 0,
        strandedActors: dryStrandedActors,
        migration,
      });
    }

    // ── Step 2: Stranded-actor check (only when parentId is supplied) ────────
    await analyse();
    warnings.push(...lateWarnings());
    let predictedStranded = [];
    if (parentId) {
      const strandedGroups = strandedNow();
      const totalStranded  = strandedGroups.reduce((s, g) => s + g.count, 0);
      predictedStranded = strandedGroups.flatMap((g) => g.actorIds);

      if (totalStranded > 0) {
        const preview = (extra = {}) => ({
          status:         'requires_confirmation',
          strandedActors: strandedGroups.map(g => ({ currentState: g.state, atVersion: g.atVersion, reason: g.reason, count: g.count })),
          safeActors:     familyActors.length - totalStranded,
          warnings,
          message:
            `${totalStranded} actor(s) could not be placed in a version they would be routed to ` +
            `(${strandedGroups.map(g => `"${g.state}" at ${g.atVersion} ×${g.count}`).join(', ')}). ` +
            `They will be stranded (needs_rescue) and stop accepting events until a rescue ` +
            `deployment provides a forward path. Re-submit this request with the confirmToken ` +
            `field to proceed, or add stateMapping entries for these states.`,
          ...extra,
        });
        if (confirmToken) {
          const result = consumeToken(confirmToken, { definitionId: id, currentStrandedCount: totalStranded });
          if (!result.ok) {
            if (result.newPreviewNeeded) {
              const fresh = issueToken({ definitionId: id, parentId, definitionHash: hashDefinition(definition), strandedGroups, totalStranded });
              return reply.code(200).send(preview({ reason: result.reason, confirmToken: fresh.token, expiresIn: fresh.expiresIn }));
            }
            return reply.code(400).send({ error: result.reason });
          }
          // Token valid — fall through to storage
        } else {
          const issued = issueToken({ definitionId: id, parentId, definitionHash: hashDefinition(definition), strandedGroups, totalStranded });
          return reply.code(200).send(preview({ confirmToken: issued.token, expiresIn: issued.expiresIn }));
        }
      }
    }

    // ── Step 3: Store definition ─────────────────────────────────────────────
    let tStar = await nextDeployTick(eng);   // unique across API servers (Postgres)

    // ── Pre-deploy registry validation ────────────────────────────────────────
    // Compile the definition before storing it. If any guard or action name
    // referenced by the definition is absent from the loaded implementation
    // registry, reject the deploy with 422 so the error surfaces at deploy
    // time rather than silently failing at runtime per event.
    // Skipped when no registry is loaded (e.g. tests that call the API without
    // a setup file) so existing workflows without a registry are unaffected.
    let _precompiledResult = null;
    // With a remote implementation service configured, validate against local + remote
    // (manifest) names — so remote-only setups also get typo checks at deploy time.
    if (remoteEnabled()) await refreshRemoteManifest({ force: true });
    const _globalRegistry = (getGlobalRegistry() || remoteEnabled())
      ? withRemote(getGlobalRegistry() ?? { guards: {}, actions: {}, services: {} }, { strict: true })
      : null;
    // `cond:` guards are checked even without a registry: a malformed expression would
    // otherwise silently evaluate to false forever.
    {
      const bad = [...JSON.stringify(definitionToStore).matchAll(/"(cond:(?:[^"\\]|\\.)*)"/g)]
        .map((m) => JSON.parse(`"${m[1]}"`))
        .filter((g) => !conditionGuard(g));
      if (bad.length > 0) {
        return reply.code(422).send({ error: `Invalid cond: guard expression(s): ${bad.join(', ')}`, missing: bad });
      }
    }
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

    try {
      await createDefinition({
        id,
        parentId:       parentId ?? null,
        definitionJson: definitionToStore,
        deployedAt:     Number(tStar),
      });
    } catch (err) {
      if (err.message?.includes('UNIQUE') || err.code === '23505') {
        return reply.code(200).send({ id, idempotent: true });
      }
      throw err;
    }

    // Save compiled form — reuse the pre-compiled result from registry validation
    // if available, otherwise compile now (registry absent path).
    // Propagate failures: a NULL compiled_json means all subsequent sendEvents fail.
    const { runtimeDef, ...compiledForm } = _precompiledResult ?? compileMachine(definitionToStore);
    await updateCompiledJson(id, compiledForm);
    if (Object.keys(compiledForm.afterTransitions).length > 0) {
      await updateDefinitionJson(id, { ...runtimeDef, _sourceHash: definitionToStore._sourceHash });
    }
    try { invalidateDefinitionCache(id); } catch {}

    // ── Register the change-point (routingRegistry.js: both fingerprint schemes) ──
    let cpRow = { cp: 0, par: 0 };
    if (hasHistoryRegions) {
      // Engine first: its return code rejects ambiguous selectors (-2). The definition row
      // then exists without a change-point, which makes it inert (nobody is routed to it).
      const rc = registerParallel({
        tStar, refinement, childDefId: id, machineId, historyRegions: normalizedHistoryRegions,
      });
      if (rc === -2) {
        return reply.code(409).send({
          error: 'Ambiguous deployment: this historyRegions selector conflicts with an existing changepoint at the same deployment tick. Ensure selectors are pairwise incompatible or add a larger selector covering their union.',
        });
      }
      const regionHexMap = computeRegionHashes(normalizedHistoryRegions, 1);   // legacy column format
      const rowId = await insertParChangepoint({ tStar: Number(tStar), regionHashesHexMap: regionHexMap, refinement, childDefId: id });
      markChangepointRowRegistered('par', rowId);
      cpRow.par = rowId;
    } else {
      // The persisted key is the legacy (v1) one, or '0' for the wildcard; the v2 key is
      // derived from the stored historyPath whenever the row is registered.
      const storedPrefix = hasHistoryPath ? fingerprintToBigInt(computeHistoryHash(historyPath, 1)).toString() : '0';
      const rowId = await insertChangepoint({ tStar: Number(tStar), prefixHash: storedPrefix, refinement, childDefId: id });
      registerScalar({ tStar, storedPrefix, refinement, childDefId: id, machineId, historyPath: hasHistoryPath ? historyPath : null });
      markChangepointRowRegistered('cp', rowId);
      cpRow.cp = rowId;
    }

    // Invalidate inline migration + definition cache for the parent definition
    if (parentId) {
      try { invalidateMigrationCacheForDefinition(parentId); } catch {}
      try { invalidateDefinitionCache(parentId); } catch {}
    }

    // ── Visibility barrier (cluster) ────────────────────────────────────────
    // The deployment is committed once every live server has registered it, or once the
    // registry lease has run out (a server that has not synced by then stops routing).
    await publishRegistryChange();
    const barrier = await awaitRegistryBarrier(cpRow);
    if (barrier.leaseExpired && barrier.pending.length) {
      request.log.warn(`[definitions] ${id}: servers ${barrier.pending.join(', ')} did not acknowledge within the registry lease; they are fenced until they sync`);
    }

    // ── Step 4: Strand the actors predicted to be stranded (only after confirm) ──
    // Through the routing itself, on the owning server under the actor's lock (the
    // internal route is forwarded to the owner in cluster mode): it routes to a fixpoint
    // and strands exactly where a mapping is missing.
    let strandedTagged = 0;
    if (parentId && confirmToken) {
      for (const actorId of predictedStranded) {
        const r = await fastify.inject({
          method: 'POST', url: `/v1/internal/actors/${encodeURIComponent(actorId)}/migrate`,
          payload: { targetDefinitionId: id },
          headers: process.env.STATEKEEP_ADMIN_KEY ? { 'x-admin-key': process.env.STATEKEEP_ADMIN_KEY } : {},
        });
        const out = r.json?.() ?? {};
        if (out.outcome === 'needs_rescue') strandedTagged++;
      }
      if (strandedTagged > 0) request.log.info(`[definitions] ${strandedTagged} actors stranded (needs_rescue) by deploying ${id}`);
    }

    // ── Step 5: Enqueue background routing for every actor with a pending route ──
    // (Liveness: stranded actors take no events, so this is how a rescue reaches them.)
    let deploymentId  = null;
    let affectedCount = 0;

    if (parentId) {
      const actors = await findActorsByMachine(machineId);
      if (actors.length > 0) {
        const pendingJobs = [];
        for (const actor of actors) {
          let targetDefId = null;
          try { targetDefId = await routeTargetFor(actor); }
          catch (e) { request.log.warn(`[definitions] routing lookup failed for ${actor.id}: ${e.message}`); }
          // A failed lookup still queues the job: its owner routes it by the rule, and the
          // job is skipped if nothing applies (liveness must not depend on this lookup).
          if (targetDefId === null && actor.status === 'needs_rescue') targetDefId = id;
          if (targetDefId && targetDefId !== actor.definitionId) {
            pendingJobs.push({ actor_id: actor.id, target_def_id: targetDefId });
          }
        }
        const wildcardThreshold = parseInt(process.env.STATEKEEP_WILDCARD_WARN_THRESHOLD ?? '10000', 10);
        if (!hasHistoryTarget && pendingJobs.length > wildcardThreshold) {
          warnings.push({
            code:    'LARGE_WILDCARD_DEPLOY',
            message: `Wildcard deployment will migrate ${pendingJobs.length} actors (threshold: ${wildcardThreshold}). ` +
                     `This may take several minutes. Use historyPath or historyRegions to target a subset of actors.`,
          });
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
      visibility:      { waitedMs: barrier.waitedMs, unacknowledged: barrier.pending ?? [] },
      warnings,        // soft warnings included even on success
    });
  }

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
  // What deploying `definition` under `parentId` would do, predicted by the same routing
  // rule and mappings as a real deployment (deployAnalysis.js). Writes nothing.
  fastify.post('/v1/definitions/preview', {
    schema: {
      body: {
        type: 'object',
        required: ['parentId', 'definition'],
        properties: {
          parentId:         { type: 'string' },
          definition:       { type: 'object' },
          historyPath:      { type: 'array' },
          historyRegions:   { type: 'object' },
          stateMapping:     { type: 'object', additionalProperties: { type: 'string' } },
          contextTransform: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const { parentId, definition, stateMapping, contextTransform } = request.body;
    const historyPath = normalizeHistoryPath(request.body.historyPath);
    const eng = getEngine();
    const hasPath = Array.isArray(historyPath) && historyPath.length > 0;

    const { errors, warnings } = analyseDefinition(definition);
    if (errors.length > 0) {
      return reply.code(400).send({ valid: false, wouldDeploy: false, errors, warnings });
    }
    const parentDef = await findDefinitionById(parentId);
    if (!parentDef) return reply.code(404).send({ error: `Definition ${parentId} not found` });
    const machineId = parentDef.machineId ?? parentId;

    let historyRegions = null;
    if (request.body.historyRegions && Object.keys(request.body.historyRegions).length > 0) {
      try {
        historyRegions = normalizeHistoryRegions(
          Object.fromEntries(Object.entries(request.body.historyRegions).map(([k, v]) => [k, normalizeHistoryPath(v)])),
          parentDef.definitionJson);
      } catch (err) { return reply.code(400).send({ error: err.message }); }
    }

    await getWriteBuffer().flush();
    try { await syncChangepointsFromDb(); } catch {}
    const actors = await findActorsByMachine(machineId);
    const candidate = {
      id: '(preview)', kind: historyRegions ? 'p' : 's', t: CANDIDATE_T,
      pattern: hasPath ? historyPath : null, historyRegions,
      definitionJson: {
        ...definition,
        ...(stateMapping && Object.keys(stateMapping).length ? { _stateMapping: stateMapping } : {}),
        ...(contextTransform && Object.keys(contextTransform).length ? { _contextTransform: contextTransform } : {}),
      },
    };
    const getDef = (defId) => findDefinitionById(defId);
    const analysis = await predictRouting({ machineId, actors, getDef, candidate });
    const late = await lateMatcherRisk({ machineId, actors, getDef, candidate });
    const strandedActors = strandedGroupsOf(analysis, actors.length)
      .map((g) => ({ currentState: g.state, atVersion: g.atVersion, reason: g.reason, count: g.count }));

    return reply.code(200).send({
      dryRun:         true,
      valid:          true,
      warnings:       [...warnings, ...(late.length ? [{ code: 'LATE_MATCHER_RISK', versions: late }] : [])],
      wouldDeploy:    strandedActors.length === 0,
      strandedActors,
      migration: {
        eligible:     actors.length,
        wouldMigrate: analysis.moves.map((m) => ({ actorId: m.actorId, hops: m.hops })),
        wouldStay:    analysis.stays.map((m) => ({ actorId: m.actorId, hops: m.hops, reason: 'not_routed_through_this_version' })),
        engineAvailable: eng.available,
      },
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
          limit:  { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
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

/**
 * Walk `historyPath` through a flat machine from its initial state.
 * Returns a human-readable problem string, or null if the path is walkable or the
 * machine is too dynamic to check (nested/parallel states, guards, timers, always).
 */
export function checkHistoryPathWalkable(def, historyPath) {
  if (!def || typeof def !== 'object' || !def.states || typeof def.initial !== 'string') return null;
  for (const s of Object.values(def.states)) {
    if (!s || typeof s !== 'object') return null;
    if (s.states || s.type === 'parallel' || s.after || s.always) return null;
    for (const t of Object.values(s.on ?? {})) {
      if (Array.isArray(t) || (t && typeof t === 'object' && (t.guard || t.cond))) return null;
    }
  }
  let state = def.initial;
  for (let i = 0; i < historyPath.length; i++) {
    const ev = historyPath[i];
    const t  = def.states[state]?.on?.[ev];
    const target = typeof t === 'string' ? t : t?.target;
    if (!target) {
      return `event '${ev}' (position ${i + 1}) is not accepted in state '${state}'` +
             (i === 0 ? ` (the machine's initial state)` : '');
    }
    state = String(target).replace(/^\./, '').replace(/^#[^.]+\./, '');
    if (!def.states[state]) return null; // unusual target syntax — don't guess
  }
  return null;
}
