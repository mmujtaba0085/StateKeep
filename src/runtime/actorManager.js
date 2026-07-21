/**
 * src/runtime/actorManager.js
 *
 * Hot actor registry (LRU) + SQLite spill + worker thread coordination.
 * Public API consumed by the Fastify route handlers.
 */

import { randomInt } from 'crypto';
import { LRUCache } from './lruCache.js';
import { fingerprintToBigInt, regionFingerprintsToArray } from '../ffi/hashUtils.js';
import { getEngine } from '../ffi/engine.js';
import { getWorkerPool } from './workerPool.js';
import { getWriteBuffer } from './writeBuffer.js';
import { processEvent }      from './interpreter.js';
import { getGlobalRegistry } from './implementationRegistry.js';
import { startInvoke, detachActorInvokes, recoverInvokes } from './invokeRegistry.js';
import { loadRunningInvokes } from '../registry/invokeRepo.js';
import {
  createActor as dbCreateActor,
  findActorById,
  updateActorState,
  updateActorStatus,
  migrateActorDefinition,
  findIdleActors,
} from '../registry/actorRepo.js';
import { findDefinitionById } from '../registry/definitionRepo.js';
import { consumePendingNotifications } from '../registry/migrationNotificationRepo.js';
import { getDb, encrypt, isPostgres } from '../registry/db.js';
import { serializeRegionFingerprints } from '../registry/regionFingerprintCodec.js';
import { emitWebhookEvent } from '../api/lib/webhookEmitter.js';
import { getWildcardChildDef, loadChangepointsAfter, loadParChangepointsAfter } from '../registry/changepointRepo.js';
import { insertActionJob } from '../registry/actionJobRepo.js';

const HOT_REGISTRY_SIZE  = parseInt(process.env.HOT_REGISTRY_SIZE    ?? '10000',  10);
const IDLE_TIMEOUT_MS    = parseInt(process.env.IDLE_TIMEOUT_SECONDS  ?? '300',    10) * 1000;

// ── Hot registry ──────────────────────────────────────────────────────────────
// Each entry: { definitionId, stateValue, context, historyFingerprint,
//               regionFingerprints, lastEventTick, lastAccess, logicalStartTick }

const hotRegistry = new LRUCache(HOT_REGISTRY_SIZE, async (actorId, entry) => {
  detachActorInvokes(actorId);  // explicit intent — invoke Promises survive independently
  try {
    await updateActorState(actorId, {
      stateValue:          entry.stateValue,
      context:             entry.context,
      historyFingerprint:  entry.historyFingerprint,
      regionFingerprints:  entry.regionFingerprints ?? null,
      lastEventTick:       entry.lastEventTick,
      status:              'active',
    });
  } catch (e) {
    if (e.code === 'SQLITE_BUSY') {
      // DB write lock held by another process (typically migrate-worker batch).
      // Defer into the write buffer so the state is retried on the next 50ms flush
      // rather than discarded. Prevents silent data loss on LRU eviction under load.
      getWriteBuffer().queueState(actorId, {
        stateValue:         entry.stateValue,
        context:            entry.context,
        historyFingerprint: entry.historyFingerprint,
        regionFingerprints: entry.regionFingerprints ?? null,
        lastEventTick:      entry.lastEventTick,
        status:             'active',
      });
    } else {
      console.error(`[actorManager] Spill failed for ${actorId}:`, e);
    }
  }
});

// ── Idle spill timer ──────────────────────────────────────────────────────────

setInterval(() => {
  const cutoff  = Date.now() - IDLE_TIMEOUT_MS;
  for (const [id, entry] of hotRegistry.entries()) {
    if (entry.lastAccess < cutoff) {
      hotRegistry.evict(id);
    }
  }
}, 60_000).unref();

// ── Lazy migration invalidation ───────────────────────────────────────────────
// Poll migration_notifications every 500ms instead of a per-event DB read.
// migrate-worker writes to this table after each migration; we evict the affected
// actor from the hot registry so the next event sees the new definition.
export const _migrationPollTimer = setInterval(async () => {
  try {
    const actorIds = await consumePendingNotifications();
    for (const id of actorIds) {
      hotRegistry.delete(id);        // delete (not evict) to avoid overwriting DB status
      const prefix = `${id}:`;
      for (const key of migrationCheckCache.keys()) {
        if (key.startsWith(prefix)) migrationCheckCache.delete(key);
      }
    }
  } catch (err) {
    console.error('[actorManager] migration poll error:', err.message);
  }
}, 500).unref();

// ── Definition JSON cache (60s TTL) ───────────────────────────────────────────
// Reduces DB reads for hot definitions hit on every spawnActor / ensureInWorker.
const _defCache    = new Map();   // definitionId → { def, expiresAt }
const DEF_CACHE_TTL_MS = 60_000;

async function cachedFindDefinition(definitionId) {
  const cached = _defCache.get(definitionId);
  if (cached && cached.expiresAt > Date.now()) return cached.def;
  const def = await findDefinitionById(definitionId);
  if (def) _defCache.set(definitionId, { def, expiresAt: Date.now() + DEF_CACHE_TTL_MS });
  return def;
}

export function invalidateDefinitionCache(definitionId) {
  _defCache.delete(definitionId);
}

// ── Inline migration check cache ──────────────────────────────────────────────
// key: `${actorId}:${definitionId}:${fingerprint}`
// Including fingerprint ensures the cache is bypassed whenever the actor's history
// changes — so actors that just processed INCOME_VERIFIED get a fresh engine
// evaluation without waiting for the TTL to expire.

const migrationCheckCache = new Map();
const MIGRATION_CACHE_TTL_TICKS = 100n;

function getCachedDecision(actorId, definitionId, fingerprint, currentTick) {
  const key    = `${actorId}:${definitionId}:${fingerprint}`;
  const cached = migrationCheckCache.get(key);
  if (!cached) return undefined;
  if (BigInt(currentTick) - cached.evaluatedAt > MIGRATION_CACHE_TTL_TICKS) {
    migrationCheckCache.delete(key);
    return undefined;
  }
  return cached.result;
}

function setCachedDecision(actorId, definitionId, fingerprint, currentTick, result) {
  migrationCheckCache.set(`${actorId}:${definitionId}:${fingerprint}`, {
    result,
    evaluatedAt: BigInt(currentTick),
  });
}

/**
 * Invalidate all cache entries for actors on `definitionId`.
 * Called after a new deployment so stale "stay" results don't block fresh routing.
 */
export function evictFromHotRegistry(...actorIds) {
  // Use delete (not evict) to avoid triggering the onEvict spill, which would
  // overwrite the DB status (e.g. needs_rescue) back to 'active'.
  for (const id of actorIds) hotRegistry.delete(id);
}

export function invalidateMigrationCacheForDefinition(definitionId) {
  // Keys are `actorId:definitionId:fingerprint` — match on the middle segment
  const segment = `:${definitionId}:`;
  for (const key of migrationCheckCache.keys()) {
    if (key.includes(segment)) migrationCheckCache.delete(key);
  }
}

// ── Decision log helper ───────────────────────────────────────────────────────

function logDecision({
  actorId, orgId = 'default', deploymentId = null, trigger, evaluatedAt,
  decision, reason, fromDefinitionId, toDefinitionId,
  actorFingerprint, prefixHash = '0',
}) {
  getWriteBuffer().queueDecision([
    actorId, orgId, deploymentId ?? null, trigger, Number(evaluatedAt),
    decision, reason,
    fromDefinitionId ?? null, toDefinitionId ?? null,
    actorFingerprint, prefixHash, Date.now(),
  ]);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the canonical dot-separated key from a stateValue (mirrors interpreter.js). */
function stateKeyOf(sv) {
  if (typeof sv === 'string') return sv;
  if (sv && typeof sv === 'object') {
    const top = Object.keys(sv)[0];
    const sub = sv[top];
    if (typeof sub === 'string') return `${top}.${sub}`;
    if (sub && typeof sub === 'object') return `${top}.${stateKeyOf(sub)}`;
    return top;
  }
  return String(sv);
}

function touch(id, entry) {
  entry.lastAccess = Date.now();
  hotRegistry.set(id, entry);
}

async function ensureInWorker(actorId, actor, priority = 'normal', orgId = '_system') {
  const pool = getWorkerPool();
  const def  = await cachedFindDefinition(actor.definitionId);
  if (!def) throw new Error(`Definition ${actor.definitionId} not found`);

  await pool.send(actorId, {
    type:           'SPAWN',
    actorId,
    definitionId:   actor.definitionId,
    definitionJson: def.definitionJson,
    existingRegionFingerprints: actor.regionFingerprints ?? null,
    stateSnapshot:  actor.stateValue
      ? { value: actor.stateValue, context: actor.context, status: 'active' }
      : undefined,
  }, { priority, orgId });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Spawn a new actor from a definition.
 */
export async function spawnActor({ definitionId, orgId, initialContext, logicalStartTick }) {
  const def = await cachedFindDefinition(definitionId);
  if (!def) throw new Error(`Definition not found: ${definitionId}`);
  if (!orgId) throw new Error('orgId is required to spawn an actor');
  if (def.orgId && def.orgId !== orgId) throw Object.assign(
    new Error(`Definition ${definitionId} does not belong to your organisation`),
    { statusCode: 404 }
  );

  const pool    = getWorkerPool();
  const actorId = (await import('uuid')).v4();

  const actorLogicalTick = logicalStartTick ?? def.deployedAt ?? 0;

  await dbCreateActor({
    id: actorId,
    definitionId,
    orgId,
    stateValue:         null,
    context:            initialContext ?? {},
    logicalStartTick:   actorLogicalTick,
    historyFingerprint: '0',
  });

  const workerResult = await pool.send(actorId, {
    type:           'SPAWN',
    actorId,
    definitionId:   def.id,
    definitionJson: def.definitionJson,
    initialContext: initialContext && Object.keys(initialContext).length > 0 ? initialContext : undefined,
  });

  // Worker may return null context if the machine has no context definition;
  // fall back to the caller-supplied initialContext so it persists in DB + hot registry.
  const effectiveContext = workerResult.context ?? initialContext ?? {};

  await updateActorState(actorId, {
    stateValue:         workerResult.stateValue,
    context:            effectiveContext,
    historyFingerprint: '0',
    regionFingerprints: workerResult.regionFingerprints ?? null,
    lastEventTick:      null,
    status:             'active',
  });

  touch(actorId, {
    definitionId,
    orgId,
    stateValue:         workerResult.stateValue,
    context:            effectiveContext,
    historyFingerprint: '0',
    regionFingerprints: workerResult.regionFingerprints ?? null,
    lastEventTick:      null,
    logicalStartTick:   actorLogicalTick,   // persisted in hot registry
    lastAccess:         Date.now(),
  });

  // Notify engine: actor born at logicalStartTick with no events yet (0n = empty fingerprint)
  try {
    const eng = getEngine();
    eng.actorStarted(BigInt(actorLogicalTick), 0n);
  } catch (e) {
    console.warn(`[actorManager] actorStarted notification failed for ${actorId}: ${e.message}`);
  }

  return { id: actorId, logicalStartTick: actorLogicalTick, ...workerResult };
}

/**
 * Send an event to an actor. Loads from SQLite if not in hot registry.
 * Performs an inline migration check before dispatching the event —
 * if the engine returns a new target definition the actor is swapped first.
 *
 * opts.eventData: optional plain object with event row fields.
 *   When provided, queued to the write buffer alongside the state update so
 *   both land in the same 50ms flush transaction.
 */
export async function sendEvent(actorId, event, tick, opts = {}) {
  const { eventData, priority = 'normal', orgId: optsOrgId, durability = 'buffered' } = opts;
  const pool = getWorkerPool();

  // Load from hot registry or SQLite.
  // Migration invalidation is handled lazily by the 500ms background poll
  // (_migrationPollTimer above) — no per-event DB read needed.
  let entry = hotRegistry.get(actorId);
  if (!entry) {
    const actor = await findActorById(actorId);
    if (!actor) throw new Error(`Actor not found: ${actorId}`);
    if (actor.status === 'terminated' || actor.status === 'archived') {
      throw new Error(`Actor ${actorId} is ${actor.status}`);
    }
    if (actor.status === 'migrating') {
      throw new Error(`Actor ${actorId} is currently being migrated — retry shortly`);
    }
    if (actor.status === 'needs_rescue') {
      throw Object.assign(
        new Error(
          `Actor ${actorId} is stranded (needs_rescue): its current state does not exist in the ` +
          `latest deployed definition. Deploy a rescue version that includes this state, ` +
          `or contact an operator. No events will be processed until the actor is rescued.`
        ),
        { code: 'ACTOR_NEEDS_RESCUE', actorId, status: 'needs_rescue' }
      );
    }
    const _ensureOrgId = optsOrgId ?? actor.orgId ?? '_system';
    await ensureInWorker(actorId, actor, priority, _ensureOrgId);
    entry = {
      definitionId:       actor.definitionId,
      orgId:              actor.orgId,
      stateValue:         actor.stateValue,
      context:            actor.context,
      historyFingerprint: actor.historyFingerprint,
      regionFingerprints: actor.regionFingerprints ?? null,
      lastEventTick:      actor.lastEventTick,
      logicalStartTick:   actor.logicalStartTick,
      stateEntryId:       actor.stateEntryId ?? 0,
      lastAccess:         Date.now(),
    };
  }

  // ── Inline migration check ─────────────────────────────────────────────────
  const eng = getEngine();
  let migratedTo = null;
  const fromDefId = entry.definitionId;  // capture before any migration reassigns entry

  if (eng.available && typeof eng.changepointCount === 'function' && eng.changepointCount() > 0) {
    const currentTick = BigInt(tick ?? eng.clockTick());
    const fp          = entry.historyFingerprint;
    const cachedResult = getCachedDecision(actorId, entry.definitionId, fp, currentTick);

    let targetDefId;
    if (cachedResult !== undefined) {
      targetDefId = cachedResult;
    } else {
      try {
        // Use the same logicalTime correction as definitions.js step-5:
        // if the actor has already migrated once, search strictly after the current
        // definition's t_star to avoid routing backward to an older version.
        const currentDef        = await cachedFindDefinition(entry.definitionId);
        const currentDeployedAt = currentDef?.deployedAt ?? 0;
        const logicalTime = currentDeployedAt > (entry.logicalStartTick ?? 0)
          ? BigInt(currentDeployedAt) + 1n
          : BigInt(entry.logicalStartTick ?? 0);

        // Scalar path
        targetDefId = eng.computeAccessible(
          fingerprintToBigInt(fp),
          logicalTime,
          currentTick
        );

        // Wildcard fallback: C engine performs exact prefix matching, so prefix_hash=0
        // never matches an actor whose fingerprint is non-zero. If the engine found
        // nothing, check the DB for a wildcard (prefix_hash='0') changepoint.
        if (!targetDefId) {
          targetDefId = await getWildcardChildDef(
            entry.definitionId,
            entry.logicalStartTick ?? 0
          );
        }

        // Parallel path: per-region fingerprints
        if (!targetDefId && entry.regionFingerprints) {
          const regionArr = regionFingerprintsToArray(entry.regionFingerprints);
          if (regionArr && regionArr.length > 0) {
            targetDefId = eng.computeAccessibleParallel(
              regionArr,
              logicalTime,
              currentTick
            );
          }
        }

        // Machine-family guard: the engine has a global changepoint registry —
        // in multi-machine environments a wildcard (prefix_hash=0) from one machine
        // family can match actors in another family. Only allow migration to a definition
        // in the SAME machine family as the actor's current definition.
        if (targetDefId && targetDefId !== entry.definitionId) {
          const targetDef = await cachedFindDefinition(targetDefId);
          if (targetDef && currentDef && targetDef.machineId !== currentDef.machineId) {
            targetDefId = null;
          }
        }

        // Backward-migration guard: never route an actor to a definition deployed
        // before the actor's current definition (engine can return stale routes when
        // logicalStartTick pre-dates multiple changepoints).
        if (targetDefId && targetDefId !== entry.definitionId) {
          const targetDef = await cachedFindDefinition(targetDefId);
          if (targetDef && currentDef && Number(targetDef.deployedAt) <= Number(currentDef.deployedAt)) {
            logDecision({
              actorId, orgId: entry.orgId, trigger: 'inline_event', evaluatedAt: currentTick,
              decision: 'stayed', reason: 'backward_migration_blocked',
              fromDefinitionId: entry.definitionId, toDefinitionId: targetDefId,
              actorFingerprint: fp,
            });
            targetDefId = null;
          }
        }
      } catch {
        targetDefId = null;
      }
      setCachedDecision(actorId, entry.definitionId, fp, currentTick, targetDefId);
    }

    if (targetDefId && targetDefId !== entry.definitionId) {
      // Version swap: migrate first, then process event on new definition
      // fromDefId is captured in outer scope above
      try {
        await migrateActor(actorId, targetDefId, { priority, orgId: entry.orgId });
        // Evict ALL cached decisions for this actor/fromDef (key now includes fingerprint)
        const _prefix = `${actorId}:${fromDefId}:`;
        for (const key of migrationCheckCache.keys()) {
          if (key.startsWith(_prefix)) migrationCheckCache.delete(key);
        }
        // Reload entry — migrateActor updated hot registry
        entry = hotRegistry.get(actorId) ?? entry;
        migratedTo = targetDefId;
        logDecision({
          actorId, orgId: entry.orgId, trigger: 'inline_event', evaluatedAt: currentTick,
          decision: 'migrated', reason: 'fingerprint_match',
          fromDefinitionId: fromDefId, toDefinitionId: targetDefId,
          actorFingerprint: fp,
        });
      } catch (migrateErr) {
        if (migrateErr.code === 'STATE_NOT_MAPPABLE') {
          logDecision({
            actorId, orgId: entry.orgId, trigger: 'inline_event', evaluatedAt: currentTick,
            decision: 'failed', reason: 'state_not_mappable',
            fromDefinitionId: fromDefId, toDefinitionId: targetDefId,
            actorFingerprint: fp,
          });
          // Actor is now needs_rescue — throw so the caller gets 409
          throw Object.assign(
            new Error(
              `Actor ${actorId} could not be migrated to ${targetDefId}: ` +
              `its current state does not exist in the new definition. ` +
              `Actor tagged needs_rescue.`
            ),
            { code: 'ACTOR_NEEDS_RESCUE', actorId, status: 'needs_rescue' }
          );
        }
        throw migrateErr;
      }
    } else if (cachedResult === undefined) {
      // First evaluation, actor stays — log it once (cache prevents duplicate logs)
      logDecision({
        actorId, orgId: entry.orgId, trigger: 'inline_event', evaluatedAt: currentTick,
        decision: 'stayed', reason: targetDefId ? 'already_current' : 'fingerprint_mismatch',
        fromDefinitionId: entry.definitionId, toDefinitionId: null,
        actorFingerprint: fp,
      });
    }
  }

  const _eventOrgId = optsOrgId ?? entry.orgId ?? '_system';

  // ── Main-thread event processing ─────────────────────────────────────────────
  const def = await cachedFindDefinition(entry.definitionId);
  if (!def?.compiledJson) {
    throw Object.assign(
      new Error(`No compiled form for definition ${entry.definitionId} — redeploy to compile`),
      { code: 'NO_COMPILED_FORM' }
    );
  }
  // ── Stale after: timeout guard ────────────────────────────────────────────────
  // The scheduler spreads payload onto the event, so stateEntryId lands at event.stateEntryId.
  // Fall back to event.payload?.stateEntryId for callers that nest it.
  if (event.type?.startsWith('__SK_TIMEOUT_')) {
    const expectedEntryId = event.stateEntryId ?? event.payload?.stateEntryId ?? event.data?.stateEntryId;
    if (expectedEntryId !== undefined && expectedEntryId !== entry.stateEntryId) {
      // Stale timer — actor has already transitioned to a different state; discard silently.
      return {
        stateValue:         entry.stateValue,
        context:            entry.context,
        historyFingerprint: entry.historyFingerprint,
        regionFingerprints: entry.regionFingerprints ?? null,
        stateEntryId:       entry.stateEntryId ?? 0,
        done:               false,
        migratedTo:         null,
        scheduledEventOps:  [],
        tier2Actions:       [],
        durableActions:     [],
        invokesToStart:     [],
      };
    }
  }

  const pendingSends = [];
  const registry     = getGlobalRegistry() ?? { guards: {}, actions: {}, services: {} };
  const interpResult = processEvent(
    { ...entry, actorId },
    def.compiledJson,
    event,
    registry,
    pendingSends,
  );

  if (interpResult.error === 'TRANSIENT_LOOP_DETECTED') {
    await updateActorStatus(actorId, 'needs_rescue');
    throw Object.assign(
      new Error(`Actor ${actorId} hit transient loop — tagged needs_rescue`),
      { code: 'TRANSIENT_LOOP_DETECTED' }
    );
  }

  // Fire Tier-2 (async, fire-and-forget) actions
  for (const { name, fn, context: ctx, event: ev } of interpResult.tier2Actions) {
    Promise.resolve().then(() => fn({ context: ctx, event: ev }, {}))
      .catch(err => console.error(`[actorManager] Tier-2 action '${name}' failed for ${actorId}:`, err.message));
  }

  // Queue durable actions to action_jobs table (retried by actionJobWorker)
  for (const { name, fn, context: ctx, event: ev, opts } of interpResult.durableActions) {
    insertActionJob({
      actorId,
      actionName:  name,
      context:     ctx,
      event:       ev,
      maxRetries:  opts?.maxRetries ?? 3,
      fireAt:      Date.now(),
    }).catch(err => console.error(`[actorManager] insertActionJob failed for '${name}':`, err.message));
  }

  // Start invoke services for the new state
  for (const serviceId of (interpResult.invokesToStart ?? [])) {
    const registry = getGlobalRegistry() ?? { guards: {}, actions: {}, services: {} };
    const serviceFn = registry.services[serviceId];
    if (serviceFn) {
      const invokeFn = serviceFn.__sk_invoke ? serviceFn.__sk_invoke.originalFn : serviceFn;
      const opts     = serviceFn.__sk_invoke ?? {};
      startInvoke(
        actorId, serviceId, invokeFn, opts,
        { context: interpResult.context, event },
        (targetId, ev) => sendEvent(targetId, ev, Date.now(), { orgId: entry.orgId })
      ).catch(err => console.error(`[actorManager] startInvoke failed for ${actorId}:`, err.message));
    }
  }

  // Dispatch cross-actor sends collected by meta.send (deferred post-transition)
  for (const { targetId, event: pendingEv } of pendingSends) {
    sendEvent(targetId, pendingEv, tick, { priority, orgId: _eventOrgId })
      .catch(err => console.error(`[actorManager] meta.send to ${targetId} failed:`, err.message));
  }

  // Normalise to same shape callers expect
  const result = {
    stateValue:         interpResult.stateValue,
    context:            interpResult.context,
    historyFingerprint: interpResult.historyFingerprint,
    regionFingerprints: entry.regionFingerprints ?? null,
    done:               interpResult.done,
  };

  const newRegionFingerprints = result.regionFingerprints ?? entry.regionFingerprints ?? null;

  // Context-diff: compare reference before mutating entry (no assign → same object)
  const contextChanged = interpResult.context !== entry.context;

  // Capture pre-event state for webhook before mutating entry in-place
  const _fromState = entry.stateValue;

  // In-place mutation — no new object, no GC pressure at high ev/s
  entry.stateValue         = result.stateValue;
  entry.context            = result.context;
  entry.historyFingerprint = result.historyFingerprint;
  entry.regionFingerprints = newRegionFingerprints;
  entry.stateEntryId       = interpResult.stateEntryId;
  entry.lastEventTick      = tick ?? Date.now();
  entry.lastAccess         = Date.now();
  hotRegistry.set(actorId, entry);  // update LRU position

  const buf = getWriteBuffer();
  // durability: 'buffered' (default) — flush every FLUSH_MS (50ms window)
  // durability: 'sync'     — flush immediately before returning (zero loss)
  // durability: 'async'    — skip write buffer entirely; relies on LRU eviction to persist
  if (durability !== 'async') {
    buf.queueState(actorId, {
      stateValue:         result.stateValue,
      context:            contextChanged ? result.context : undefined,
      historyFingerprint: result.historyFingerprint,
      regionFingerprints: newRegionFingerprints,
      lastEventTick:      tick ?? Date.now(),
      stateEntryId:       interpResult.stateEntryId,
      status:             result.done ? 'terminated' : 'active',
      _omitContextWrite:  !contextChanged,
    });
    if (eventData) buf.queueEvent(eventData);
    if (durability === 'sync') await buf.flush();
  }

  // ── after: scheduled event lifecycle ──────────────────────────────────────────
  // Queue cancel of old state's timers and creation of new state's timers.
  // These are processed atomically with the state write in the next flush().
  // scheduledEventOps queued regardless of durability — timer state must persist
  // even for async-mode callers; stale-guard in sendEvent protects against misfires
  if (interpResult.scheduledEventOps?.length > 0) {
    for (const op of interpResult.scheduledEventOps) {
      if (op.op === 'cancel') {
        buf.queueScheduledCancel(actorId, op.stateKey);
      } else if (op.op === 'create') {
        for (const { eventType, delayMs } of op.entries) {
          buf.queueScheduledCreate({
            actorId,
            orgId:   entry.orgId,
            eventType,
            fireAt:  Date.now() + delayMs,
            payload: { stateEntryId: op.newEntryId },
          });
        }
      }
    }
  }

  if (result.done) {
    try {
      const _eng = getEngine();
      if (_eng.available) {
        _eng.actorStopped(
          BigInt(entry.logicalStartTick ?? 0),
          fingerprintToBigInt(result.historyFingerprint)
        );
      }
    } catch {}
  }

  // Emit webhook events (never throws — emitWebhookEvent swallows errors)
  const orgId = entry.orgId;
  if (orgId) {
    emitWebhookEvent(orgId, 'state.changed', {
      actorId,
      fromState: _fromState,
      toState:   result.stateValue,
      event:     event.type ?? event,
    });
    if (migratedTo) {
      emitWebhookEvent(orgId, 'actor.migrated', {
        actorId,
        fromDef: fromDefId,
        toDef:   migratedTo,
      });
    }
    if (result.done) {
      emitWebhookEvent(orgId, 'actor.terminated', { actorId });
    }
  }

  return { ...result, migratedTo };
}

/**
 * Get current actor state snapshot.
 */
export async function getActorState(actorId, { priority = 'normal' } = {}) {
  const actor = await findActorById(actorId);
  if (!actor) throw new Error(`Actor not found: ${actorId}`);

  // If DB says terminated or archived, return DB state — do not consult hot registry.
  // Archived actors may still be in the hot cache from before force-archive ran.
  if (actor.status === 'terminated' || actor.status === 'archived') {
    return {
      actorId:      actor.id,
      definitionId: actor.definitionId,
      stateValue:   actor.stateValue,
      context:      actor.context,
      regionFingerprints: actor.regionFingerprints ?? null,
      status:       actor.status,
    };
  }

  const hot = hotRegistry.get(actorId);
  if (hot) {
    const pool = getWorkerPool();
    try {
      const snap = await pool.send(actorId, { type: 'SNAPSHOT', actorId }, { priority, orgId: actor.orgId ?? '_system' });
      if (snap) {
        touch(actorId, { ...hot, lastAccess: Date.now() });
        // Augment worker snapshot with registry metadata not held by the worker thread.
        return {
          ...snap,
          definitionId:       hot.definitionId,
          historyFingerprint: hot.historyFingerprint,
          regionFingerprints: hot.regionFingerprints ?? null,
          status:             hot.status ?? actor.status ?? 'active',
        };
      }
    } catch {}
    return {
      actorId,
      stateValue:         hot.stateValue,
      context:            hot.context,
      definitionId:       hot.definitionId,
      historyFingerprint: hot.historyFingerprint,
      regionFingerprints: hot.regionFingerprints ?? null,
      status:             hot.status ?? actor.status ?? 'active',
    };
  }

  return {
    actorId:            actor.id,
    definitionId:       actor.definitionId,
    stateValue:         actor.stateValue,
    context:            actor.context,
    historyFingerprint: actor.historyFingerprint,
    regionFingerprints: actor.regionFingerprints ?? null,
    status:             actor.status,
  };
}

/**
 * Terminate an actor.
 */
export async function terminateActor(actorId, { priority = 'normal', orgId } = {}) {
  const pool = getWorkerPool();

  // Capture before removal so actorStopped gets accurate args
  const hot    = hotRegistry.get(actorId);
  const fromDb = hot ? null : await findActorById(actorId);
  const fp     = hot?.historyFingerprint ?? fromDb?.historyFingerprint ?? '0';
  const lst    = hot?.logicalStartTick   ?? fromDb?.logicalStartTick   ?? 0;
  const _orgId = orgId ?? hot?.orgId ?? fromDb?.orgId ?? '_system';

  try {
    await pool.send(actorId, { type: 'TERMINATE', actorId }, { priority, orgId: _orgId });
  } catch {}

  hotRegistry.delete(actorId);
  const _prefix = `${actorId}:`;
  for (const key of migrationCheckCache.keys()) {
    if (key.startsWith(_prefix)) migrationCheckCache.delete(key);
  }
  getWriteBuffer().flushActor(actorId);  // persist latest state before marking terminal
  await updateActorStatus(actorId, 'terminated');

  try {
    const eng = getEngine();
    if (eng.available) eng.actorStopped(BigInt(lst), fingerprintToBigInt(fp));
  } catch {}

  if (_orgId && _orgId !== '_system') emitWebhookEvent(_orgId, 'actor.terminated', { actorId });
}

/**
 * Migrate an actor to a new definition (called by migrate-worker and inline).
 * Throws with code 'STATE_NOT_MAPPABLE' if the actor's state cannot be resolved.
 */
export async function migrateActor(actorId, targetDefinitionId, { priority = 'normal', orgId } = {}) {
  const pool   = getWorkerPool();
  const actor  = await findActorById(actorId);
  if (!actor) throw new Error(`Actor not found: ${actorId}`);

  const targetDef = await cachedFindDefinition(targetDefinitionId);
  if (!targetDef) throw new Error(`Target definition not found: ${targetDefinitionId}`);

  const stateMapping     = targetDef.definitionJson._stateMapping    ?? {};
  const contextTransform = targetDef.definitionJson._contextTransform ?? null;
  const _orgId           = orgId ?? actor.orgId ?? '_system';

  const result = await pool.send(actorId, {
    type:                 'HYDRATE',
    actorId,
    targetDefinitionId,
    targetDefinitionJson: targetDef.definitionJson,
    oldContext:           actor.context,
    currentStateValue:    actor.stateValue,
    stateMapping,
    existingFingerprint:  actor.historyFingerprint,
    existingRegionFingerprints: actor.regionFingerprints ?? null,
    contextTransform,
  }, { priority, orgId: _orgId });

  if (result && result.error === 'STATE_NOT_MAPPABLE') {
    throw Object.assign(
      new Error(`STATE_NOT_MAPPABLE: actor ${actorId} in state ${JSON.stringify(result.currentStateValue)}`),
      { code: 'STATE_NOT_MAPPABLE', currentStateValue: result.currentStateValue }
    );
  }

  if (result && result.error === 'CONTEXT_TRANSFORM_FAILED') {
    throw Object.assign(
      new Error(`CONTEXT_TRANSFORM_FAILED: actor ${actorId}: ${result.message}`),
      { code: 'CONTEXT_TRANSFORM_FAILED', message: result.message }
    );
  }

  const newLogicalStartTick = Number(targetDef.deployedAt) + 1;
  const newEntryId          = randomInt(0, 2 ** 32);

  // ── Atomic DB update ───────────────────────────────────────────────────────
  // SQLite: single transaction cancels old after: timers, updates actor,
  // and schedules after: timers for the new state — all or nothing.
  // Postgres: best-effort (cancel then update); atomic transaction variant omitted
  // since the primary deployment is SQLite.
  if (!isPostgres) {
    const db        = getDb();
    const encCtx    = result.context != null
      ? encrypt(Buffer.from(JSON.stringify(result.context)))
      : null;
    db.transaction(() => {
      // 1. Cancel all pending after: timers for this actor (old state exited)
      db.prepare(
        `UPDATE scheduled_events SET status='cancelled'
         WHERE actor_id=? AND event_type LIKE '__SK_TIMEOUT_%' AND status='pending'`
      ).run(actorId);

      // 2. Update actor definition, state, and stateEntryId atomically
      db.prepare(
        `UPDATE actors
         SET definition_id=?, state_value=?, context_json=?,
             region_fingerprints=?, logical_start_tick=?, state_entry_id=?,
             status='active', updated_at=?
         WHERE id=?`
      ).run(
        targetDefinitionId,
        result.stateValue != null ? JSON.stringify(result.stateValue) : null,
        encCtx,
        serializeRegionFingerprints(result.regionFingerprints ?? null),
        newLogicalStartTick,
        newEntryId,
        Date.now(),
        actorId
      );

      // 3. Schedule after: timers for the new state (if any)
      const afterTransitions = targetDef.compiledJson?.afterTransitions;
      if (afterTransitions) {
        const newStateKey = stateKeyOf(result.stateValue);
        const afters      = afterTransitions[newStateKey] ?? [];
        if (afters.length > 0) {
          const insertSched = db.prepare(
            `INSERT INTO scheduled_events
               (actor_id, org_id, event_type, payload_enc, fire_at, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?)`
          );
          const now = Date.now();
          for (const { delayMs, eventType } of afters) {
            insertSched.run(
              actorId, actor.orgId, eventType,
              encrypt(JSON.stringify({ stateEntryId: newEntryId })),
              now + delayMs, now
            );
          }
        }
      }
    })();
  } else {
    // Postgres: update definition including stateEntryId; cancel + recreate after: timers.
    await migrateActorDefinition(actorId, {
      definitionId:       targetDefinitionId,
      stateValue:         result.stateValue,
      context:            result.context,
      regionFingerprints: result.regionFingerprints ?? null,
      logicalStartTick:   newLogicalStartTick,
      stateEntryId:       newEntryId,
    });
    try {
      const { query } = await import('../registry/db-postgres.js');
      await query(
        `UPDATE scheduled_events SET status='cancelled'
         WHERE actor_id=$1 AND event_type LIKE '__SK_TIMEOUT_%' AND status='pending'`,
        [actorId]
      );
      // Create after: timers for the new state
      const afterTransitions = targetDef.compiledJson?.afterTransitions;
      if (afterTransitions) {
        const newStateKey = stateKeyOf(result.stateValue);
        const afters      = afterTransitions[newStateKey] ?? [];
        if (afters.length > 0) {
          const now = Date.now();
          for (const { delayMs, eventType } of afters) {
            await query(
              `INSERT INTO scheduled_events
                 (actor_id, org_id, event_type, payload_enc, fire_at, status, created_at)
               VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
              [actorId, actor.orgId, eventType,
               encrypt(JSON.stringify({ stateEntryId: newEntryId })),
               now + delayMs, now]
            );
          }
        }
      }
    } catch (e) {
      console.warn(`[actorManager] migrateActor: failed to manage timers for ${actorId}: ${e.message}`);
    }
  }

  try {
    const eng = getEngine();
    eng.actorStarted(BigInt(targetDef.deployedAt), fingerprintToBigInt(actor.historyFingerprint));
  } catch (e) {
    console.warn(`[actorManager] actorStarted notification failed for ${actorId}: ${e.message}`);
  }

  if (hotRegistry.has(actorId)) {
    const existing = hotRegistry.get(actorId);
    touch(actorId, {
      definitionId:       targetDefinitionId,
      orgId:              existing?.orgId ?? actor.orgId,
      stateValue:         result.stateValue,
      context:            result.context,
      historyFingerprint: actor.historyFingerprint,
      regionFingerprints: result.regionFingerprints ?? null,
      lastEventTick:      actor.lastEventTick,
      logicalStartTick:   newLogicalStartTick,
      stateEntryId:       newEntryId,
      lastAccess:         Date.now(),
    });
  }

  return result;
}

/**
 * Seed the in-process APV engine registry from all changepoints persisted in the DB.
 * Call once at API server startup — the engine starts with an empty registry after
 * every process restart, so changepoints deployed before the restart must be re-registered.
 *
 * Also pre-warms the XState machine cache in every worker thread so the first
 * real SPAWN/HYDRATE for an active definition has zero compile cost.
 */
export async function seedEngineRegistry() {
  const eng = getEngine();
  if (eng.available) {
    const scalars = await loadChangepointsAfter(0);
    for (const row of scalars) {
      try {
        eng.registerChangepoint(
          BigInt(row.t_star),
          BigInt(row.prefix_hash),
          BigInt(row.refinement),
          row.child_def_id
        );
      } catch (e) {
        console.warn(`[actorManager] seedEngineRegistry skip ${row.child_def_id}: ${e.message}`);
      }
    }

    const parallels = await loadParChangepointsAfter(0);
    for (const row of parallels) {
      try {
        const storedRegions = JSON.parse(row.region_hashes);
        const regionArr = Array.isArray(storedRegions)
          ? storedRegions.map(h => BigInt(`0x${String(h).padStart(16, '0')}`))
          : regionFingerprintsToArray(storedRegions);
        if (!regionArr || regionArr.length === 0) continue;
        eng.registerChangepointParallel(
          BigInt(row.t_star),
          regionArr,
          BigInt(row.refinement),
          row.child_def_id
        );
      } catch (e) {
        console.warn(`[actorManager] seedEngineRegistry skip parallel ${row.child_def_id}: ${e.message}`);
      }
    }

    if (scalars.length + parallels.length > 0) {
      console.log(`[actorManager] Engine registry seeded: ${scalars.length} scalar + ${parallels.length} parallel changepoints`);
    }
  }

  await preWarmMachines();

  // Recover in-flight invokes that survived a server restart
  try {
    const staleInvokes = await loadRunningInvokes();
    if (staleInvokes.length > 0) {
      const reg = getGlobalRegistry() ?? { guards: {}, actions: {}, services: {} };
      await recoverInvokes(
        staleInvokes,
        (id, ev) => sendEvent(id, ev, Date.now(), {}),
        reg
      ).catch(err => console.error('[actorManager] invoke recovery error:', err.message));
    }
  } catch (err) {
    console.error('[actorManager] invoke recovery error:', err.message);
  }
}

async function preWarmMachines() {
  const sql = `SELECT DISTINCT d.id, d.definition_json
               FROM actors a
               JOIN definitions d ON d.id = a.definition_id
               WHERE a.status IN ('active','needs_rescue')`;
  let defs;
  try {
    if (isPostgres) {
      const { queryAll } = await import('../registry/db-postgres.js');
      defs = await queryAll(sql);
    } else {
      const { getDb } = await import('../registry/db.js');
      defs = getDb().prepare(sql).all();
    }
  } catch {
    return;
  }
  if (!defs || defs.length === 0) return;

  const pool  = getWorkerPool();
  const tasks = [];
  for (const row of defs) {
    let definitionJson;
    try { definitionJson = JSON.parse(row.definition_json); } catch { continue; }
    for (let i = 0; i < pool.workerCount; i++) {
      tasks.push(pool.sendToSlot(i, { type: 'PRECOMPILE', definitionId: row.id, definitionJson }));
    }
  }
  await Promise.allSettled(tasks);
  if (defs.length > 0) {
    console.log(`[actorManager] Pre-warmed ${defs.length} definitions across ${getWorkerPool().workerCount} workers`);
  }
}

export { hotRegistry };
