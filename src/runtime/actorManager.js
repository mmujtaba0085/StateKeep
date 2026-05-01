/**
 * src/runtime/actorManager.js
 *
 * Hot actor registry (LRU) + SQLite spill + worker thread coordination.
 * Public API consumed by the Fastify route handlers.
 */

import { LRUCache } from './lruCache.js';
import { FNV_OFFSET, fingerprintToBigInt } from '../ffi/hashUtils.js';
import { getEngine } from '../ffi/engine.js';
import { getWorkerPool } from './workerPool.js';
import {
  createActor as dbCreateActor,
  findActorById,
  updateActorState,
  updateActorStatus,
  migrateActorDefinition,
  findIdleActors,
} from '../registry/actorRepo.js';
import { findDefinitionById } from '../registry/definitionRepo.js';
import { getDb } from '../registry/db.js';
import { emitWebhookEvent } from '../api/lib/webhookEmitter.js';

const HOT_REGISTRY_SIZE  = parseInt(process.env.HOT_REGISTRY_SIZE    ?? '10000',  10);
const IDLE_TIMEOUT_MS    = parseInt(process.env.IDLE_TIMEOUT_SECONDS  ?? '300',    10) * 1000;

// ── Hot registry ──────────────────────────────────────────────────────────────
// Each entry: { definitionId, stateValue, context, historyFingerprint,
//               lastEventTick, lastAccess, logicalStartTick }

const hotRegistry = new LRUCache(HOT_REGISTRY_SIZE, async (actorId, entry) => {
  try {
    updateActorState(actorId, {
      stateValue:          entry.stateValue,
      context:             entry.context,
      historyFingerprint:  entry.historyFingerprint,
      lastEventTick:       entry.lastEventTick,
      status:              'active',
    });
  } catch (e) {
    console.error(`[actorManager] Spill failed for ${actorId}:`, e);
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

// ── Inline migration check cache ──────────────────────────────────────────────
// key: `${actorId}:${definitionId}`
// value: { result: targetDefId | null, evaluatedAt: BigInt (engine tick) }

const migrationCheckCache = new Map();
const MIGRATION_CACHE_TTL_TICKS = 100n;

function getCachedDecision(actorId, definitionId, currentTick) {
  const cached = migrationCheckCache.get(`${actorId}:${definitionId}`);
  if (!cached) return undefined;
  if (BigInt(currentTick) - cached.evaluatedAt > MIGRATION_CACHE_TTL_TICKS) {
    migrationCheckCache.delete(`${actorId}:${definitionId}`);
    return undefined;
  }
  return cached.result;
}

function setCachedDecision(actorId, definitionId, currentTick, result) {
  migrationCheckCache.set(`${actorId}:${definitionId}`, {
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
  const suffix = `:${definitionId}`;
  for (const key of migrationCheckCache.keys()) {
    if (key.endsWith(suffix)) migrationCheckCache.delete(key);
  }
}

// ── Decision log helper ───────────────────────────────────────────────────────

function logDecision({
  actorId, orgId = 'default', deploymentId = null, trigger, evaluatedAt,
  decision, reason, fromDefinitionId, toDefinitionId,
  actorFingerprint, prefixHash = '0',
}) {
  try {
    getDb().prepare(`
      INSERT INTO migration_decisions
        (actor_id, org_id, deployment_id, trigger, evaluated_at, decision, reason,
         from_definition_id, to_definition_id, actor_fingerprint, prefix_hash, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      actorId, orgId, deploymentId ?? null, trigger, Number(evaluatedAt),
      decision, reason,
      fromDefinitionId ?? null, toDefinitionId ?? null,
      actorFingerprint, prefixHash, Date.now()
    );
  } catch (e) {
    console.warn(`[actorManager] decision log failed: ${e.message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function touch(id, entry) {
  entry.lastAccess = Date.now();
  hotRegistry.set(id, entry);
}

async function ensureInWorker(actorId, actor) {
  const pool = getWorkerPool();
  const def  = findDefinitionById(actor.definitionId);
  if (!def) throw new Error(`Definition ${actor.definitionId} not found`);

  await pool.send(actorId, {
    type:           'SPAWN',
    actorId,
    definitionJson: def.definitionJson,
    stateSnapshot:  actor.stateValue
      ? { value: actor.stateValue, context: actor.context, status: 'active' }
      : undefined,
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Spawn a new actor from a definition.
 */
export async function spawnActor({ definitionId, orgId, initialContext, logicalStartTick }) {
  const def = findDefinitionById(definitionId);
  if (!def) throw new Error(`Definition not found: ${definitionId}`);
  if (!orgId) throw new Error('orgId is required to spawn an actor');
  if (def.orgId && def.orgId !== orgId) throw Object.assign(
    new Error(`Definition ${definitionId} does not belong to your organisation`),
    { statusCode: 404 }
  );

  const pool    = getWorkerPool();
  const actorId = (await import('uuid')).v4();

  const actorLogicalTick = logicalStartTick ?? def.deployedAt ?? 0;

  dbCreateActor({
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
    definitionJson: def.definitionJson,
    initialContext: initialContext && Object.keys(initialContext).length > 0 ? initialContext : undefined,
  });

  // Worker may return null context if the machine has no context definition;
  // fall back to the caller-supplied initialContext so it persists in DB + hot registry.
  const effectiveContext = workerResult.context ?? initialContext ?? {};

  updateActorState(actorId, {
    stateValue:         workerResult.stateValue,
    context:            effectiveContext,
    historyFingerprint: '0',
    lastEventTick:      null,
    status:             'active',
  });

  touch(actorId, {
    definitionId,
    orgId,
    stateValue:         workerResult.stateValue,
    context:            effectiveContext,
    historyFingerprint: '0',
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
 */
export async function sendEvent(actorId, event, tick) {
  const pool = getWorkerPool();

  // Load from hot registry or SQLite
  let entry = hotRegistry.get(actorId);
  if (!entry) {
    const actor = findActorById(actorId);
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
    await ensureInWorker(actorId, actor);
    entry = {
      definitionId:       actor.definitionId,
      orgId:              actor.orgId,
      stateValue:         actor.stateValue,
      context:            actor.context,
      historyFingerprint: actor.historyFingerprint,
      lastEventTick:      actor.lastEventTick,
      logicalStartTick:   actor.logicalStartTick,   // always carry this through
      lastAccess:         Date.now(),
    };
  }

  // ── Inline migration check ─────────────────────────────────────────────────
  const eng = getEngine();
  let migratedTo = null;

  if (eng.available) {
    const currentTick = BigInt(tick ?? eng.clockTick());
    const fp          = entry.historyFingerprint;
    const cachedResult = getCachedDecision(actorId, entry.definitionId, currentTick);

    let targetDefId;
    if (cachedResult !== undefined) {
      targetDefId = cachedResult;
    } else {
      try {
        targetDefId = eng.computeAccessible(
          fingerprintToBigInt(fp),
          BigInt(entry.logicalStartTick ?? 0),
          currentTick
        );
      } catch {
        targetDefId = null;
      }
      setCachedDecision(actorId, entry.definitionId, currentTick, targetDefId);
    }

    if (targetDefId && targetDefId !== entry.definitionId) {
      // Version swap: migrate first, then process event on new definition
      const fromDefId = entry.definitionId;
      try {
        await migrateActor(actorId, targetDefId);
        migrationCheckCache.delete(`${actorId}:${fromDefId}`);
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

  // Dispatch event (on current or just-swapped definition)
  const result = await pool.send(actorId, {
    type:               'EVENT',
    actorId,
    event,
    historyFingerprint: entry.historyFingerprint,
  });

  // Update hot registry
  const newEntry = {
    definitionId:       entry.definitionId,
    orgId:              entry.orgId,
    stateValue:         result.stateValue,
    context:            result.context,
    historyFingerprint: result.historyFingerprint,
    lastEventTick:      tick ?? Date.now(),
    logicalStartTick:   entry.logicalStartTick,
    lastAccess:         Date.now(),
  };
  touch(actorId, newEntry);

  updateActorState(actorId, {
    stateValue:         result.stateValue,
    context:            result.context,
    historyFingerprint: result.historyFingerprint,
    lastEventTick:      tick ?? Date.now(),
    status:             result.done ? 'terminated' : 'active',
  });

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
  const orgId = entry.orgId ?? newEntry.orgId;
  if (orgId) {
    emitWebhookEvent(orgId, 'state.changed', {
      actorId,
      fromState: entry.stateValue,
      toState:   result.stateValue,
      event:     event.type ?? event,
    });
    if (migratedTo) {
      emitWebhookEvent(orgId, 'actor.migrated', {
        actorId,
        fromDef: entry.definitionId,
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
export async function getActorState(actorId) {
  const actor = findActorById(actorId);
  if (!actor) throw new Error(`Actor not found: ${actorId}`);

  // If DB says terminated or archived, return DB state — do not consult hot registry.
  // Archived actors may still be in the hot cache from before force-archive ran.
  if (actor.status === 'terminated' || actor.status === 'archived') {
    return {
      actorId:    actor.id,
      stateValue: actor.stateValue,
      context:    actor.context,
      status:     actor.status,
    };
  }

  const hot = hotRegistry.get(actorId);
  if (hot) {
    const pool = getWorkerPool();
    try {
      const snap = await pool.send(actorId, { type: 'SNAPSHOT', actorId });
      if (snap) {
        touch(actorId, { ...hot, lastAccess: Date.now() });
        return snap;
      }
    } catch {}
    return { actorId, stateValue: hot.stateValue, context: hot.context };
  }

  return {
    actorId:            actor.id,
    stateValue:         actor.stateValue,
    context:            actor.context,
    historyFingerprint: actor.historyFingerprint,
    status:             actor.status,
  };
}

/**
 * Terminate an actor.
 */
export async function terminateActor(actorId) {
  const pool = getWorkerPool();

  // Capture before removal so actorStopped gets accurate args
  const hot    = hotRegistry.get(actorId);
  const fromDb = hot ? null : findActorById(actorId);
  const fp     = hot?.historyFingerprint ?? fromDb?.historyFingerprint ?? '0';
  const lst    = hot?.logicalStartTick   ?? fromDb?.logicalStartTick   ?? 0;

  try {
    await pool.send(actorId, { type: 'TERMINATE', actorId });
  } catch {}

  hotRegistry.delete(actorId);
  const _prefix = `${actorId}:`;
  for (const key of migrationCheckCache.keys()) {
    if (key.startsWith(_prefix)) migrationCheckCache.delete(key);
  }
  updateActorStatus(actorId, 'terminated');

  try {
    const eng = getEngine();
    if (eng.available) eng.actorStopped(BigInt(lst), fingerprintToBigInt(fp));
  } catch {}

  const orgId = hot?.orgId ?? fromDb?.orgId;
  if (orgId) emitWebhookEvent(orgId, 'actor.terminated', { actorId });
}

/**
 * Migrate an actor to a new definition (called by migrate-worker and inline).
 * Throws with code 'STATE_NOT_MAPPABLE' if the actor's state cannot be resolved.
 */
export async function migrateActor(actorId, targetDefinitionId) {
  const pool   = getWorkerPool();
  const actor  = findActorById(actorId);
  if (!actor) throw new Error(`Actor not found: ${actorId}`);

  const targetDef = findDefinitionById(targetDefinitionId);
  if (!targetDef) throw new Error(`Target definition not found: ${targetDefinitionId}`);

  const stateMapping = targetDef.definitionJson._stateMapping ?? {};

  const result = await pool.send(actorId, {
    type:                 'HYDRATE',
    actorId,
    targetDefinitionJson: targetDef.definitionJson,
    oldContext:           actor.context,
    currentStateValue:    actor.stateValue,
    stateMapping,
  });

  if (result && result.error === 'STATE_NOT_MAPPABLE') {
    throw Object.assign(
      new Error(`STATE_NOT_MAPPABLE: actor ${actorId} in state ${JSON.stringify(result.currentStateValue)}`),
      { code: 'STATE_NOT_MAPPABLE', currentStateValue: result.currentStateValue }
    );
  }

  migrateActorDefinition(actorId, {
    definitionId: targetDefinitionId,
    stateValue:   result.stateValue,
    context:      result.context,
  });

  if (hotRegistry.has(actorId)) {
    const existing = hotRegistry.get(actorId);
    touch(actorId, {
      definitionId:       targetDefinitionId,
      orgId:              existing?.orgId ?? actor.orgId,
      stateValue:         result.stateValue,
      context:            result.context,
      historyFingerprint: actor.historyFingerprint,
      lastEventTick:      actor.lastEventTick,
      logicalStartTick:   existing?.logicalStartTick ?? actor.logicalStartTick,
      lastAccess:         Date.now(),
    });
  }

  return result;
}

export { hotRegistry };
