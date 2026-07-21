/**
 * src/lib/index.js
 *
 * Embedded library mode — run StateKeep in-process without an HTTP server.
 *
 * Usage:
 *   import { createStateKeep } from 'statekeep/lib';
 *   const sk = await createStateKeep({ dbPath: './data.db', encryptionKey: '...' });
 *   const actor = await sk.spawnActor({ definitionId, context: {} });
 *   await sk.sendEvent(actor.id, { type: 'SUBMIT' });
 *   await sk.close();
 */

export async function createStateKeep({
  dbPath,
  encryptionKey,
  workerCount,
  dbUrl,
  setup,
} = {}) {
  // Env vars must be set before first lazy import of singletons
  if (dbUrl)         process.env.STATEKEEP_DB_URL        = dbUrl;
  if (dbPath)        process.env.STATEKEEP_DB_PATH        = dbPath;
  if (encryptionKey) process.env.STATEKEEP_ENCRYPTION_KEY = encryptionKey;
  if (workerCount)   process.env.STATEKEEP_WORKER_COUNT   = String(workerCount);

  // Silence all internal logs in embedded mode unless caller has set a level.
  // Users get result objects back, not log streams.
  process.env.LOG_LEVEL ??= 'silent';

  const { engineReady, getEngine } = await import('../ffi/engine.js');
  await engineReady;

  const { isPostgres, getDb } = await import('../registry/db.js');

  if (isPostgres) {
    const { bootstrapSchema } = await import('../registry/db-postgres.js');
    await bootstrapSchema();
  } else {
    getDb();
  }

  // Seed APV clock past the highest changepoint tick from a prior run
  const { getMaxTStar } = await import('../registry/changepointRepo.js');
  try {
    const maxTStar = await getMaxTStar();
    if (maxTStar > 0) {
      const eng = getEngine();
      let t = eng.clockTick();
      while (Number(t) <= maxTStar) t = eng.clockTick();
    }
  } catch {}

  const {
    seedEngineRegistry,
    spawnActor: _spawn,
    sendEvent: _sendEvent,
    getActorState,
    terminateActor: _terminate,
  } = await import('../runtime/actorManager.js');

  await seedEngineRegistry();

  // Wire guards/actions/services from setup into the global implementation registry
  // Must happen before starting the action job worker so it sees the correct registry.
  if (setup?.machines) {
    const { loadRegistry, setGlobalRegistry } = await import('../runtime/implementationRegistry.js');
    const merged = { guards: {}, actions: {}, services: {} };
    for (const machineSetup of Object.values(setup.machines)) {
      const s = machineSetup?.setup ?? machineSetup ?? {};
      Object.assign(merged.guards,   s.guards   ?? {});
      Object.assign(merged.actions,  s.actions  ?? {});
      Object.assign(merged.services, s.services ?? {});
    }
    setGlobalRegistry(loadRegistry(merged));
  }

  const { startActionJobWorker, stopActionJobWorker } = await import('../runtime/actionJobWorker.js');
  const { getGlobalRegistry } = await import('../runtime/implementationRegistry.js');
  startActionJobWorker(
    (actorId, event) => _sendEvent(actorId, event, Date.now(), {}),
    getGlobalRegistry()
  );

  const { getWorkerPool } = await import('../runtime/workerPool.js');
  getWorkerPool();

  const { deployDefinition: _deploy } = await import('./deploy.js');

  return {
    async deployDefinition(definitionJson, options = {}) {
      return _deploy(definitionJson, options);
    },

    async spawnActor({ definitionId, context, initialContext } = {}) {
      if (!definitionId) throw new Error('definitionId is required');
      const result = await _spawn({ definitionId, initialContext: context ?? initialContext });
      return result;
    },

    async sendEvent(actorId, event, { durability = 'buffered' } = {}) {
      if (!actorId) throw new Error('actorId is required');
      const clockTick = Number(getEngine().clockTick());
      return _sendEvent(actorId, event, clockTick, { durability });
    },

    async getActor(actorId) {
      if (!actorId) throw new Error('actorId is required');
      return getActorState(actorId);
    },

    async terminateActor(actorId) {
      if (!actorId) throw new Error('actorId is required');
      return _terminate(actorId, {});
    },

    async close() {
      // Stop durable action worker before flushing
      try { stopActionJobWorker(); } catch {}
      // Flush pending writes before terminating workers, then close DB
      try { const { getWriteBuffer } = await import('../runtime/writeBuffer.js'); getWriteBuffer().flush(); } catch {}
      await new Promise(r => setTimeout(r, 100)); // let flush settle
      try { getWorkerPool().terminate(); } catch {}
      await new Promise(r => setTimeout(r, 200)); // let workers drain
      if (isPostgres) {
        try { const { closePool } = await import('../registry/db-postgres.js'); await closePool(); } catch {}
      } else {
        try { getDb().close(); } catch {}
      }
    },
  };
}
