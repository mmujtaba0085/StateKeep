/**
 * src/runtime/actorManager.js
 *
 * Hot actor registry (LRU) + SQLite spill + worker thread coordination.
 * Public API consumed by the Fastify route handlers.
 */

import { withConditions } from './conditionGuards.js';
import { randomUUID } from 'crypto';
import { randomInt } from 'crypto';
import { LRUCache } from './lruCache.js';
import { fingerprintToBigInt, regionFingerprintsToArray } from '../ffi/hashUtils.js';
import { computeHistoryFingerprint } from '../ffi/fingerprintChain.js';
import { getEngine, scopeOf } from '../ffi/engine.js';
import { getWorkerPool } from './workerPool.js';
import { getWriteBuffer, makeActionJobRow } from './writeBuffer.js';
import { processEvent, computeInitialSnapshot } from './interpreter.js';
import { compileMachine }    from './definitionCompiler.js';
import { initializeRegionFingerprints } from './statePaths.js';
import { getGlobalRegistry } from './implementationRegistry.js';
import { withRemote, remoteEnabled, prefetchRemoteGuards, setCurrentGuardResults } from './remoteImplementations.js';
import { startInvoke, detachActorInvokes, recoverInvokes } from './invokeRegistry.js';
import { loadRunningInvokes } from '../registry/invokeRepo.js';
import {
  createActor as dbCreateActor,
  findActorById,
  updateActorState,
  updateActorStatus,
} from '../registry/actorRepo.js';
import { findDefinitionById } from '../registry/definitionRepo.js';
import { consumePendingNotifications } from '../registry/migrationNotificationRepo.js';
import { getDb, encrypt, isPostgres } from '../registry/db.js';
import { serializeRegionFingerprints } from '../registry/regionFingerprintCodec.js';
import { emitWebhookEvent } from '../api/lib/webhookEmitter.js';
import { findFamilyChangepoint, loadChangepointsAfter, loadParChangepointsAfter } from '../registry/changepointRepo.js';
import { cancelAllPendingForActor } from '../registry/scheduledEventRepo.js';

const HOT_REGISTRY_SIZE  = parseInt(process.env.HOT_REGISTRY_SIZE    ?? '10000',  10);
const IDLE_TIMEOUT_MS    = parseInt(process.env.IDLE_TIMEOUT_SECONDS  ?? '300',    10) * 1000;

// ── Hot registry ──────────────────────────────────────────────────────────────
// Each entry: { definitionId, stateValue, context, historyFingerprint,
//               regionFingerprints, lastEventTick, lastAccess, logicalStartTick }

const hotRegistry = new LRUCache(HOT_REGISTRY_SIZE, async (actorId, entry) => {
  detachActorInvokes(actorId);  // explicit intent — invoke Promises survive independently
  // Must persist state before dropping registry entry: next event will HYDRATE from DB, recovering from last successful write
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
// Change-points deployed through another API server (or another process) are
// registered here too — otherwise this server's inline check never routed its actors
// to them. Incremental by row id.
let _lastCpId = 0, _lastParCpId = 0;
async function syncChangepointsFromDb() {
  const eng = getEngine();
  if (!eng.available) return;
  // (A row whose definition is not visible yet is retried on the next poll: it cannot
  //  be registered in its family's scope without knowing the family.)
  const rows = await loadChangepointsAfter(_lastCpId);
  for (const row of rows) {
    if (!row.machine_id) break;
    try { eng.registerChangepoint(BigInt(row.t_star), BigInt(row.prefix_hash), BigInt(row.refinement), row.child_def_id, scopeOf(row.machine_id)); } catch {}
    _lastCpId = Math.max(_lastCpId, Number(row.id));
  }
  const par = await loadParChangepointsAfter(_lastParCpId);
  for (const row of par) {
    if (!row.machine_id) break;
    try {
      const stored = JSON.parse(row.region_hashes);
      const arr = Array.isArray(stored) ? stored.map((h) => BigInt(`0x${String(h).padStart(16, '0')}`)) : regionFingerprintsToArray(stored);
      if (arr?.length) eng.registerChangepointParallel(BigInt(row.t_star), arr, BigInt(row.refinement), row.child_def_id, scopeOf(row.machine_id));
    } catch {}
    _lastParCpId = Math.max(_lastParCpId, Number(row.id));
  }
  if (rows.length + par.length > 0) {
    registryEpoch++;
    migrationCheckCache.clear();   // stale "stay" answers
    // Deployments made through another server: later ticks here must not fall behind them.
    const maxT = Math.max(0, ...rows.map((r) => Number(r.t_star)), ...par.map((r) => Number(r.t_star)));
    if (maxT > 0) eng.advanceClockTo(maxT);
  }
}

export const _migrationPollTimer = setInterval(async () => {
  try {
    await syncChangepointsFromDb().catch(() => {});
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
// 60s TTL: definitions change rarely but must eventually expire so a fresh deployment is picked up without restart
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
// Bumped whenever the registry may have gained a change-point. A decision computed under
// an older epoch is not cached (it may predate a deployment that is now visible).
let registryEpoch = 0;
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

export function invalidateMigrationCacheForDefinition(_definitionId) {
  // A new change-point can apply to actors on ANY version of its family (not only the
  // parent's), so every cached "stay" answer is dropped — otherwise an actor could keep
  // a stale answer after the deployment is visible.
  registryEpoch++;
  migrationCheckCache.clear();
}

// ── Decision log helper ───────────────────────────────────────────────────────

function logDecision({
  actorId, deploymentId = null, trigger, evaluatedAt,
  decision, reason, fromDefinitionId, toDefinitionId,
  actorFingerprint, prefixHash = '0',
}) {
  getWriteBuffer().queueDecision([
    actorId, deploymentId ?? null, trigger, Number(evaluatedAt),
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

async function ensureInWorker(actorId, actor, priority = 'normal') {
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
  }, { priority });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Spawn a new actor from a definition.
 */
const _emptyRegistry = withConditions({ guards: {}, actions: {}, services: {} });

export async function spawnActor({ definitionId, initialContext, logicalStartTick, spawnKey = null, spawnEventTick = null }) {
  const def = await cachedFindDefinition(definitionId);
  if (!def) throw new Error(`Definition not found: ${definitionId}`);

  // Compute initial snapshot on the main thread so we can do a single DB write
  // with the full state — eliminating the two-write window (null stateValue → real state).
  const compiledJson = def.compiledJson ?? compileMachine(def.definitionJson);
  // Same implementations as events use: the initial state's entry actions run and its
  // timers are scheduled (before, spawn used an empty registry and dropped both).
  const spawnRegistry = withRemote(getGlobalRegistry() ?? { guards: {}, actions: {}, services: {} });
  const snapResult   = computeInitialSnapshot(compiledJson, def.definitionJson, initialContext ?? {}, spawnRegistry);
  if (snapResult.error) throw new Error(`Failed to compute initial snapshot: ${snapResult.error}`);

  const stateValue         = snapResult.stateValue;
  const effectiveContext   = snapResult.context ?? initialContext ?? {};
  const historyFingerprint = snapResult.historyFingerprint ?? '0';
  const regionFingerprints = initializeRegionFingerprints(def.definitionJson, stateValue, null);

  const pool    = getWorkerPool();
  const actorId = randomUUID();

  // Logical time (APV model): at least one past the version's deployment time. Spawns by
  // family pass nothing; pinned spawns pass one past the newest deployment of the family.
  const actorLogicalTick = Math.max(logicalStartTick ?? 0, Number(def.deployedAt ?? 0) + 1);

  // Single write: the actor with its full initial state, its initial entry-action jobs
  // and timers, its SPAWN audit event and the client's idempotency key — one transaction,
  // committed before the spawn is acknowledged. (Before, the jobs and timers followed in
  // a later write: a crash in between left an actor whose first actions never ran.)
  const actionJobs = (snapResult.durableActions ?? []).map((d) => makeActionJobRow({
    actorId, actionName: d.name, context: d.context, event: d.event,
    maxRetries: d.opts?.maxRetries ?? 3, fireAt: Date.now() }));
  const timers = [];
  if (!snapResult.done) {
    for (const op of snapResult.scheduledEventOps ?? []) {
      if (op.op !== 'create') continue;
      for (const { eventType, delayMs } of op.entries) {
        timers.push({ eventType, fireAt: Date.now() + delayMs,
          payloadEnc: encrypt(JSON.stringify({ stateEntryId: op.newEntryId })) });
      }
    }
  }
  await dbCreateActor({
    id:                 actorId,
    definitionId,
    stateValue,
    context:            effectiveContext,
    logicalStartTick:   actorLogicalTick,
    historyFingerprint,
    regionFingerprints,
    // A machine can finish during spawn (eventless transitions into a final state):
    // it is created finished, like one that finishes on an event.
    status:             snapResult.done ? 'terminated' : 'active',
    stateEntryId:       snapResult.stateEntryId ?? 0,   // the initial state's timers carry it
    spawnKey, actionJobs, timers,
    spawnEvent:         spawnEventTick != null ? { tick: Number(spawnEventTick), processedAt: Date.now() } : null,
  });
  if (snapResult.done) {
    return { id: actorId, logicalStartTick: actorLogicalTick, actorId, stateValue, context: effectiveContext,
      historyFingerprint, regionFingerprints, status: 'done', done: true };
  }

  // Pre-load worker with snapshot (skips re-computation in worker for idempotent reload).
  await pool.send(actorId, {
    type:                       'SPAWN',
    actorId,
    definitionId:               def.id,
    definitionJson:             def.definitionJson,
    stateSnapshot:              { value: stateValue, context: effectiveContext, status: 'active' },
    existingRegionFingerprints: regionFingerprints ?? null,
  });

  touch(actorId, {
    definitionId,
    stateValue,
    context:          effectiveContext,
    historyFingerprint,
    regionFingerprints,
    lastEventTick:    null,
    logicalStartTick: actorLogicalTick,
    stateEntryId:     snapResult.stateEntryId ?? 0,
    lastAccess:       Date.now(),
  });

  // Notify engine: actor born at logicalStartTick with no events yet (0n = empty fingerprint)
  try {
    const eng = getEngine();
    eng.actorStarted(BigInt(actorLogicalTick), 0n);
  } catch (e) {
    console.warn(`[actorManager] actorStarted notification failed for ${actorId}: ${e.message}`);
  }

  return {
    id: actorId,
    logicalStartTick: actorLogicalTick,
    actorId,
    stateValue,
    context:          effectiveContext,
    historyFingerprint,
    regionFingerprints,
    status:           snapResult.done ? 'done' : 'active',
    done:             snapResult.done ?? false,
  };
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
// Default durability for events. 'group' (default): the call resolves only after the
// state + event rows are committed (group commit, shared transaction per tick).
// 'buffered': legacy behaviour — returns before the write, up to FLUSH_MS of
// acknowledged events can be lost on a crash. 'sync': flush alone, per event.
const DEFAULT_DURABILITY = process.env.STATEKEEP_DURABILITY ?? 'group';

// ── Per-actor serialization ───────────────────────────────────────────────────
// Everything that reads an actor's state and writes a new one (events, migrations)
// runs one at a time per actor. Without this, two requests for one actor that
// interleaved across an await (a cold load, a definition lookup, a remote guard)
// both computed from the same old state, and a batch migration in another process
// could overwrite events processed meanwhile.
const _actorLocks = new Map();   // actorId → tail promise
export async function withActorLock(actorId, fn) {
  const prev = _actorLocks.get(actorId) ?? Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const tail = prev.then(() => mine);
  _actorLocks.set(actorId, tail);
  await prev;
  try { return await fn(); }
  finally {
    release();
    if (_actorLocks.get(actorId) === tail) _actorLocks.delete(actorId);
  }
}

export async function sendEvent(actorId, event, tick, opts = {}) {
  return withActorLock(actorId, () => _sendEventLocked(actorId, event, tick, opts));
}

const MAX_ROUTING_HOPS = 32;

/**
 * The APV routing decision for one actor (docs/apv.md, Definition "accessibility"):
 * the earliest applicable change-point of the actor's own workflow family at or after
 * its logical time — an exact history match outranks the wildcard at the same time, and
 * scalar change-points are consulted before parallel (regional) ones.
 * Returns the target definition id, or null to stay.
 */
async function computeRoute(actorId, entry, currentTick) {
  const eng = getEngine();
  try {
    const currentDef  = await cachedFindDefinition(entry.definitionId);
    const logicalTime = logicalTimeOf(entry, currentDef);
    const scope       = scopeOf(currentDef?.machineId);
    const fp          = entry.historyFingerprint;
    let targetDefId = eng.computeAccessible(fingerprintToBigInt(fp), logicalTime, currentTick, scope);
    if (!targetDefId && entry.regionFingerprints) {
      const regionArr = regionFingerprintsToArray(entry.regionFingerprints);
      if (regionArr && regionArr.length > 0) {
        targetDefId = eng.computeAccessibleParallel(regionArr, logicalTime, currentTick, scope);
      }
    }
    if (targetDefId && targetDefId !== entry.definitionId) {
      const targetDef = await cachedFindDefinition(targetDefId);
      // An engine build without scopes can answer with another workflow's change-point:
      // then ask the database for this family's (same rule).
      if (targetDef && currentDef && targetDef.machineId !== currentDef.machineId) {
        targetDefId = await findFamilyChangepoint(entry.definitionId, fingerprintToBigInt(fp).toString(), logicalTime);
      }
    }
    if (targetDefId && targetDefId !== entry.definitionId) {
      const targetDef = await cachedFindDefinition(targetDefId);
      // Defensive: never route to a version deployed before the current one.
      if (targetDef && currentDef && Number(targetDef.deployedAt) <= Number(currentDef.deployedAt)) {
        logDecision({
          actorId, trigger: 'inline_event', evaluatedAt: currentTick,
          decision: 'stayed', reason: 'backward_migration_blocked',
          fromDefinitionId: entry.definitionId, toDefinitionId: targetDefId,
          actorFingerprint: fp,
        });
        return null;
      }
    }
    return targetDefId ?? null;
  } catch {
    return undefined;   // lookup failed: stay for now, and do not cache it
  }
}

/** The actor's logical time: at least one past its current version's deployment. */
function logicalTimeOf(entry, currentDef) {
  const dep = BigInt(currentDef?.deployedAt ?? 0) + 1n;
  const own = BigInt(entry.logicalStartTick ?? 0);
  return own > dep ? own : dep;
}

async function _sendEventLocked(actorId, event, tick, opts = {}) {
  const { eventData, priority = 'normal', durability = DEFAULT_DURABILITY, mergePayload = null } = opts;
  const pool = getWorkerPool();

  // Load from hot registry or SQLite.
  // Migration invalidation is handled lazily by the 500ms background poll
  // (_migrationPollTimer above) — no per-event DB read needed.
  let entry = hotRegistry.get(actorId);
  if (!entry) {
    const actor = await findActorById(actorId);
    if (!actor) throw new Error(`Actor not found: ${actorId}`);
    if (actor.status === 'terminated' || actor.status === 'archived') {
      throw Object.assign(new Error(`Actor ${actorId} is ${actor.status}`),
        { code: actor.status === 'archived' ? 'ACTOR_ARCHIVED' : 'ACTOR_TERMINATED', statusCode: 409 });
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
    await ensureInWorker(actorId, actor, priority);
    entry = {
      definitionId:       actor.definitionId,
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
    // Route to a fixpoint before the event is processed: after migrating through an
    // earlier deployment, a later one may still apply to the same (unchanged) history.
    // Each hop strictly increases the actor's logical time, so this terminates.
    for (let hop = 0; hop < MAX_ROUTING_HOPS; hop++) {
      const fp = entry.historyFingerprint;
      const cachedResult = hop === 0 ? getCachedDecision(actorId, entry.definitionId, fp, currentTick) : undefined;
      let targetDefId;
      if (cachedResult !== undefined) {
        targetDefId = cachedResult;
      } else {
        const epoch = registryEpoch;
        targetDefId = await computeRoute(actorId, entry, currentTick);
        // Never cache a failed lookup (undefined), nor an answer computed before the
        // registry changed.
        if (targetDefId !== undefined && epoch === registryEpoch) {
          setCachedDecision(actorId, entry.definitionId, fp, currentTick, targetDefId);
        }
        targetDefId = targetDefId ?? null;
      }
      if (!targetDefId || targetDefId === entry.definitionId) {
        if (hop === 0 && cachedResult === undefined) {
          logDecision({
            actorId, trigger: 'inline_event', evaluatedAt: currentTick,
            decision: 'stayed', reason: targetDefId ? 'already_current' : 'fingerprint_mismatch',
            fromDefinitionId: entry.definitionId, toDefinitionId: null,
            actorFingerprint: fp,
          });
        }
        break;
      }
      const hopFrom = entry.definitionId;
      try {
        await migrateActor(actorId, targetDefId, { priority, trigger: 'inline' });
        const _prefix = `${actorId}:${hopFrom}:`;
        for (const key of migrationCheckCache.keys()) {
          if (key.startsWith(_prefix)) migrationCheckCache.delete(key);
        }
        entry = hotRegistry.get(actorId) ?? entry;   // migrateActor updated the hot registry
        migratedTo = targetDefId;
        logDecision({
          actorId, trigger: 'inline_event', evaluatedAt: currentTick,
          decision: 'migrated', reason: 'fingerprint_match',
          fromDefinitionId: hopFrom, toDefinitionId: targetDefId,
          actorFingerprint: fp,
        });
      } catch (migrateErr) {
        if (migrateErr.code === 'STATE_NOT_MAPPABLE' || migrateErr.code === 'CONTEXT_TRANSFORM_FAILED') {
          logDecision({
            actorId, trigger: 'inline_event', evaluatedAt: currentTick,
            decision: 'failed', reason: migrateErr.code === 'STATE_NOT_MAPPABLE' ? 'state_not_mappable' : 'context_transform_failed',
            fromDefinitionId: hopFrom, toDefinitionId: targetDefId,
            actorFingerprint: fp,
          });
          // Stranded exactly as the background path does: recorded on the target version,
          // status needs_rescue, MIGRATION_FAILED in its history. It takes no more events
          // until a rescue deployment moves it.
          await strandActor(actorId, hopFrom, targetDefId, migrateErr, null);
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
    }
  }

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

  // docs/API.md: an event's `payload` is merged into the actor context. It is merged
  // BEFORE the transition so the event's own guards and actions can use the data it
  // carries (e.g. an imported Step Functions Choice reading the previous task's output).
  let procEntry = entry;
  if (mergePayload && typeof mergePayload === 'object') {
    const { type: _ignored, ...fields } = mergePayload;
    if (Object.keys(fields).length > 0) procEntry = { ...entry, context: { ...entry.context, ...fields } };
  }

  const pendingSends = [];
  const localRegistry = getGlobalRegistry() ?? { guards: {}, actions: {}, services: {} };
  const registry      = withRemote(localRegistry);
  // Remote (HTTP) guards cannot run inside the synchronous interpreter: evaluate the
  // ones this event can reach first, then hand their results in (see remoteImplementations.js).
  const remoteGuardResults = remoteEnabled()
    ? await prefetchRemoteGuards({ compiledJson: def.compiledJson, event, entry: procEntry, actorId, localGuards: localRegistry.guards })
    : null;
  setCurrentGuardResults(remoteGuardResults);
  let interpResult;
  try {
    interpResult = processEvent(
      { ...procEntry, actorId },
      def.compiledJson,
      event,
      registry,
      pendingSends,
    );
  } finally {
    setCurrentGuardResults(null);
  }

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
  // Durable action jobs go through the write buffer so they commit in the same
  // transaction as this transition (see WriteBuffer.queueActionJob).
  const _durableJobs = interpResult.durableActions.map(({ name, context: ctx, event: ev, opts }) => ({
    actorId,
    actionName:  name,
    context:     ctx,
    event:       ev,
    maxRetries:  opts?.maxRetries ?? 3,
    fireAt:      Date.now(),
  }));

  // Start invoke services for the new state
  for (const invoke of (interpResult.invokesToStart ?? [])) {
    const invokeId   = invoke.id  ?? invoke;   // id for done.invoke.${id} event name
    const serviceSrc = invoke.src ?? invoke;   // src for registry.services[src] lookup
    const registry = getGlobalRegistry() ?? { guards: {}, actions: {}, services: {} };
    const serviceFn = registry.services[serviceSrc];
    if (serviceFn) {
      const invokeFn = serviceFn.__sk_invoke ? serviceFn.__sk_invoke.originalFn : serviceFn;
      const opts     = serviceFn.__sk_invoke ?? {};
      startInvoke(
        actorId, invokeId, invokeFn, opts,
        { context: interpResult.context, event },
        (targetId, ev) => sendEvent(targetId, ev, Date.now(), {})
      ).catch(err => console.error(`[actorManager] startInvoke failed for ${actorId}:`, err.message));
    }
  }

  // Dispatch cross-actor sends collected by meta.send (deferred post-transition)
  for (const { targetId, event: pendingEv } of pendingSends) {
    sendEvent(targetId, pendingEv, tick, { priority })
      .catch(err => console.error(`[actorManager] meta.send to ${targetId} failed:`, err.message));
  }

  // Normalise to same shape callers expect
  const result = {
    stateValue:         interpResult.stateValue,
    context:            interpResult.context,
    historyFingerprint: interpResult.historyFingerprint,
    regionFingerprints: entry.regionFingerprints ?? null,
    stateEntryId:       interpResult.stateEntryId,
    done:               interpResult.done,
  };

  const newRegionFingerprints = result.regionFingerprints ?? entry.regionFingerprints ?? null;

  // Context-diff: compare reference before mutating entry (no assign → same object).
  // Always write context on termination: getActorState reads from DB for terminated actors,
  // and an in-place mutation (context.foo = val, returning undefined) shares the same reference
  // so reference equality would miss the change.
  const contextChanged = result.done || interpResult.context !== entry.context;

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
    for (const job of _durableJobs) buf.queueActionJob(job);
    if (durability === 'sync') await buf.flush();
  } else {
    for (const job of _durableJobs) buf.queueActionJob(job);  // never drop durable work
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
    // Flush terminal status to DB immediately and evict from hot cache so
    // getActorState falls through to the DB and returns 'terminated' correctly.
    // Without this, getActorState returns status:'active' for any hot-cache hit.
    await buf.flushActor(actorId);
    hotRegistry.delete(actorId);
  }

  // Group commit: don't acknowledge (or fire webhooks for) a transition that isn't on disk yet.
  if (durability === 'group') await buf.durable();

  // Emit webhook events (never throws — emitWebhookEvent swallows errors)
  emitWebhookEvent('state.changed', {
    actorId,
    fromState: _fromState,
    toState:   result.stateValue,
    event:     event.type ?? event,
  });
  if (migratedTo) {
    emitWebhookEvent('actor.migrated', {
      actorId,
      fromDef: fromDefId,
      toDef:   migratedTo,
    });
  }
  if (result.done) {
    emitWebhookEvent('actor.terminated', { actorId });
  }

  return { ...result, migratedTo };
}

/**
 * Get current actor state snapshot.
 */
export async function getActorState(actorId, { priority = 'normal' } = {}) {
  // Hot path: terminateActor and archive operations call hotRegistry.delete() before
  // updating DB status, so a live hot entry always reflects current actor state.
  const hot = hotRegistry.get(actorId);
  if (hot) {
    touch(actorId, { ...hot, lastAccess: Date.now() });
    return {
      actorId,
      stateValue:         hot.stateValue,
      context:            hot.context,
      definitionId:       hot.definitionId,
      historyFingerprint: hot.historyFingerprint,
      regionFingerprints: hot.regionFingerprints ?? null,
      status:             'active',
    };
  }

  const actor = await findActorById(actorId);
  if (!actor) throw new Error(`Actor not found: ${actorId}`);

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
export async function terminateActor(actorId, { priority = 'normal' } = {}) {
  const pool = getWorkerPool();

  // Capture before removal so actorStopped gets accurate args
  const hot    = hotRegistry.get(actorId);
  const fromDb = hot ? null : await findActorById(actorId);
  const fp     = hot?.historyFingerprint ?? fromDb?.historyFingerprint ?? '0';
  const lst    = hot?.logicalStartTick   ?? fromDb?.logicalStartTick   ?? 0;

  try {
    await pool.send(actorId, { type: 'TERMINATE', actorId }, { priority });
  } catch {}

  hotRegistry.delete(actorId);
  const _prefix = `${actorId}:`;
  for (const key of migrationCheckCache.keys()) {
    if (key.startsWith(_prefix)) migrationCheckCache.delete(key);
  }
  await getWriteBuffer().flushActor(actorId);  // persist latest state before marking terminal
  await cancelAllPendingForActor(actorId);      // cancel any outstanding scheduled events
  await updateActorStatus(actorId, 'terminated');

  try {
    const eng = getEngine();
    if (eng.available) eng.actorStopped(BigInt(lst), fingerprintToBigInt(fp));
  } catch {}

  emitWebhookEvent('actor.terminated', { actorId });
}

/**
 * Migrate an actor to a new definition (called by migrate-worker and inline).
 * Throws with code 'STATE_NOT_MAPPABLE' if the actor's state cannot be resolved.
 */
export async function migrateActor(actorId, targetDefinitionId, { priority = 'normal', trigger = null } = {}) {
  // APV: fingerprint-based routing means no event replay — only the current snapshot is mapped to the new definition
  const pool   = getWorkerPool();
  // The mapping starts from the database row, so first write anything the hot path has
  // processed but not yet saved (a stale row would undo those events, and a pending
  // state write flushed after this migration would overwrite it).
  await getWriteBuffer().flush();
  const actor  = await findActorById(actorId);
  if (!actor) throw new Error(`Actor not found: ${actorId}`);

  const targetDef = await cachedFindDefinition(targetDefinitionId);
  if (!targetDef) throw new Error(`Target definition not found: ${targetDefinitionId}`);

  const stateMapping     = targetDef.definitionJson._stateMapping    ?? {};
  const contextTransform = targetDef.definitionJson._contextTransform ?? null;

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
  }, { priority });

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
  // Audit: the MIGRATED event is written in the same transaction as the migration, so
  // an actor's history always replays to its current state (no gap after a crash, and
  // it is ordered before any event processed on the new version).
  const auditPayload = encrypt(Buffer.from(JSON.stringify({
    fromDefinitionId: actor.definitionId, toDefinitionId: targetDefinitionId,
    fromState: actor.stateValue, toState: result.stateValue, ...(trigger ? { trigger } : {}),
  })));
  const auditTick = (() => { try { return Number(getEngine().clockTick()); } catch { return Date.now(); } })();

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

      db.prepare(
        `INSERT INTO events (actor_id, event_type, event_payload, tick, processed_at) VALUES (?, 'MIGRATED', ?, ?, ?)`
      ).run(actorId, auditPayload, auditTick, Date.now());

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
               (actor_id, event_type, payload_enc, fire_at, status, created_at)
             VALUES (?, ?, ?, ?, 'pending', ?)`
          );
          const now = Date.now();
          for (const { delayMs, eventType } of afters) {
            insertSched.run(
              actorId, eventType,
              encrypt(JSON.stringify({ stateEntryId: newEntryId })),
              now + delayMs, now
            );
          }
        }
      }
    })();
  } else {
    // Postgres: wrap actor update + timer cancel/recreate in a single transaction.
    const { transaction: pgTransaction } = await import('../registry/db-postgres.js');
    const encCtx = result.context != null
      ? encrypt(Buffer.from(JSON.stringify(result.context)))
      : null;
    await pgTransaction(async (client) => {
      await client.query(
        `INSERT INTO events (actor_id, event_type, event_payload, tick, processed_at) VALUES ($1, 'MIGRATED', $2, $3, $4)`,
        [actorId, auditPayload, auditTick, Date.now()]
      );
      // 1. Update actor definition and state atomically
      await client.query(
        `UPDATE actors SET
           definition_id=$1, state_value=$2, context_json=$3,
           region_fingerprints=$4, logical_start_tick=$5, state_entry_id=$6,
           status='active', updated_at=$7
         WHERE id=$8`,
        [targetDefinitionId,
         result.stateValue != null ? JSON.stringify(result.stateValue) : null,
         encCtx, serializeRegionFingerprints(result.regionFingerprints ?? null),
         newLogicalStartTick, newEntryId, Date.now(), actorId]
      );

      // 2. Cancel pending after: timers for the old state
      await client.query(
        `UPDATE scheduled_events SET status='cancelled'
         WHERE actor_id=$1 AND event_type LIKE '__SK_TIMEOUT_%' AND status='pending'`,
        [actorId]
      );

      // 3. Schedule after: timers for the new state (if any)
      const afterTransitions = targetDef.compiledJson?.afterTransitions;
      if (afterTransitions) {
        const newStateKey = stateKeyOf(result.stateValue);
        const afters      = afterTransitions[newStateKey] ?? [];
        if (afters.length > 0) {
          const tsNow = Date.now();
          for (const { delayMs, eventType } of afters) {
            await client.query(
              `INSERT INTO scheduled_events
                 (actor_id, event_type, payload_enc, fire_at, status, created_at)
               VALUES ($1,$2,$3,$4,'pending',$5)`,
              [actorId, eventType,
               encrypt(JSON.stringify({ stateEntryId: newEntryId })),
               tsNow + delayMs, tsNow]
            );
          }
        }
      }
    });
  }

  try {
    const eng = getEngine();
    eng.actorStarted(BigInt(targetDef.deployedAt), fingerprintToBigInt(actor.historyFingerprint));
  } catch (e) {
    console.warn(`[actorManager] actorStarted notification failed for ${actorId}: ${e.message}`);
  }

  // Always (not only when the actor is already hot): an inline migration of an actor
  // that was just loaded from the database continues with the hot entry, and must not
  // go on processing on the old version (seen after a server restart).
  {
    touch(actorId, {
      definitionId:       targetDefinitionId,
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
 * A batch migration, applied by the server that owns the actor — under the actor's lock,
 * against its current state (not a copy another process read earlier). Re-checks that
 * the move is still valid at this moment. Used by the migrate worker through
 * POST /v1/internal/actors/:id/migrate.
 *
 * @returns {{ outcome: 'migrated'|'already'|'skipped'|'needs_rescue', reason?, stateValue? }}
 */
/** Park an actor whose state the target version cannot hold (APV: stranded). Called
 *  with the actor's lock held. It is recorded on the target version with its old
 *  state, marked needs_rescue, and MIGRATION_FAILED is written to its history. */
async function strandActor(actorId, fromDefId, targetDefId, err, deploymentId) {
  hotRegistry.delete(actorId);
  const payload = encrypt(Buffer.from(JSON.stringify({ fromDefinitionId: fromDefId, toDefinitionId: targetDefId,
    reason: err.code, stateValue: err.currentStateValue ?? null, deploymentId })));
  const now = Date.now();
  if (isPostgres) {
    const { transaction } = await import('../registry/db-postgres.js');
    await transaction(async (client) => {
      await client.query(`UPDATE actors SET definition_id=$1, status='needs_rescue', updated_at=$2 WHERE id=$3`, [targetDefId, now, actorId]);
      await client.query(`INSERT INTO events (actor_id, event_type, event_payload, tick, processed_at) VALUES ($1,'MIGRATION_FAILED',$2,$3,$4)`, [actorId, payload, now, now]);
    });
  } else {
    const db = getDb();
    db.transaction(() => {
      db.prepare(`UPDATE actors SET definition_id = ?, status = 'needs_rescue', updated_at = ? WHERE id = ?`).run(targetDefId, now, actorId);
      db.prepare(`INSERT INTO events (actor_id, event_type, event_payload, tick, processed_at) VALUES (?, 'MIGRATION_FAILED', ?, ?, ?)`).run(actorId, payload, now, now);
    })();
  }
}

export async function migrateActorOwned(actorId, targetDefinitionId, { deploymentId = null } = {}) {
  return withActorLock(actorId, async () => {
    const actor = await findActorById(actorId);
    if (!actor) return { outcome: 'skipped', reason: 'not_found' };
    if (['terminated', 'archived'].includes(actor.status)) return { outcome: 'skipped', reason: 'finished' };
    const hot = hotRegistry.get(actorId);
    let currentDefId = hot?.definitionId ?? actor.definitionId;
    // No separate checks here: the routing rule below decides (family, logical time,
    // pattern) exactly as the inline path does.
    // make sure the database has everything the owner processed for this actor —
    // its events too, so they sit before the MIGRATED marker in its history
    await getWriteBuffer().flush();
    // The deployment that queued this job may have been made through another server and
    // not polled here yet. Stranded actors take no events, so this may be their only
    // chance to be routed: load every committed change-point first (throws → retried).
    await syncChangepointsFromDb();
    // The job names the deployment that queued it, but the actor is routed by the same
    // rule as inline: the earliest applicable change-point at or after its logical time.
    // (An actor pinned after the deployment is not applicable; an earlier deployment it
    // has not taken yet comes first.) Route to a fixpoint, like the inline path.
    let hopTarget = null;
    try {
      let result = null;
      const tick = BigInt(getEngine().clockTick());
      for (let hop = 0; hop < MAX_ROUTING_HOPS; hop++) {
        const now = hotRegistry.get(actorId) ?? await findActorById(actorId);
        const route = await computeRoute(actorId, now, tick);
        if (route === undefined) throw new Error('routing lookup failed — retry');   // job is retried
        if (!route || route === now.definitionId) break;
        hopTarget = route;
        currentDefId = now.definitionId;
        result = await migrateActor(actorId, route, { priority: 'low', trigger: 'batch' });
      }
      if (!result) return { outcome: 'skipped', reason: 'not_applicable' };
      return { outcome: 'migrated', stateValue: result.stateValue };
    } catch (err) {
      targetDefinitionId = hopTarget ?? targetDefinitionId;
      if (err.code !== 'STATE_NOT_MAPPABLE' && err.code !== 'CONTEXT_TRANSFORM_FAILED') throw err;
      await strandActor(actorId, currentDefId, targetDefinitionId, err, deploymentId);
      return { outcome: 'needs_rescue', reason: err.code, stateValue: err.currentStateValue ?? null };
    }
  });
}

/**
 * Seed the in-process APV engine registry from all changepoints persisted in the DB.
 * Call once at API server startup — the engine starts with an empty registry after
 * every process restart, so changepoints deployed before the restart must be re-registered.
 *
 * Also pre-warms the compiled definition cache in every worker thread so the first
 * real SPAWN/HYDRATE for an active definition has zero compile cost.
 */
export async function seedEngineRegistry() {
  // Engine is in-process WASM and loses its changepoint graph on every restart — rebuild from DB before serving events
  const eng = getEngine();
  if (eng.available) {
    const scalars = await loadChangepointsAfter(0);
    for (const row of scalars) _lastCpId = Math.max(_lastCpId, Number(row.id));
    for (const row of scalars) {
      try {
        eng.registerChangepoint(
          BigInt(row.t_star),
          BigInt(row.prefix_hash),
          BigInt(row.refinement),
          row.child_def_id,
          scopeOf(row.machine_id)
        );
      } catch (e) {
        console.warn(`[actorManager] seedEngineRegistry skip ${row.child_def_id}: ${e.message}`);
      }
    }

    const parallels = await loadParChangepointsAfter(0);
    for (const row of parallels) _lastParCpId = Math.max(_lastParCpId, Number(row.id));
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
          row.child_def_id,
          scopeOf(row.machine_id)
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
