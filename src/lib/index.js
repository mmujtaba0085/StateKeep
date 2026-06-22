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
  enginePath,
  workerCount,
  dbUrl,
} = {}) {
  // Env vars must be set before first lazy import of singletons
  if (dbUrl)         process.env.STATEKEEP_DB_URL        = dbUrl;
  if (dbPath)        process.env.STATEKEEP_DB_PATH        = dbPath;
  if (encryptionKey) process.env.STATEKEEP_ENCRYPTION_KEY = encryptionKey;
  if (enginePath)    process.env.STATEKEEP_ENGINE_PATH    = enginePath;
  if (workerCount)   process.env.STATEKEEP_WORKER_COUNT   = String(workerCount);

  const { engineReady, getEngine } = await import('../ffi/engine.js');
  await engineReady;

  const { isPostgres, getDb } = await import('../registry/db.js');

  if (isPostgres) {
    const { bootstrapSchema } = await import('../registry/db-postgres.js');
    await bootstrapSchema();
  } else {
    getDb();
  }

  // Seed APV clock from existing changepoints
  const { getMaxTStar } = await import('../registry/changepointRepo.js');
  try {
    const maxTStar = await getMaxTStar();
    if (maxTStar > 0) {
      const eng = getEngine();
      if (!eng.available) {
        eng.seedTick(maxTStar);
      } else {
        let t = eng.clockTick();
        while (Number(t) <= maxTStar) t = eng.clockTick();
      }
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

  const { getWorkerPool } = await import('../runtime/workerPool.js');
  getWorkerPool();

  const { deployDefinition: _deploy } = await import('./deploy.js');

  const orgId = 'default';

  return {
    async deployDefinition(definitionJson, options = {}) {
      return _deploy(definitionJson, { orgId, ...options });
    },

    async spawnActor({ definitionId, context, initialContext } = {}) {
      if (!definitionId) throw new Error('definitionId is required');
      const result = await _spawn({ definitionId, orgId, initialContext: context ?? initialContext });
      return result;
    },

    async sendEvent(actorId, event) {
      if (!actorId) throw new Error('actorId is required');
      const eng       = getEngine();
      const clockTick = eng.available ? Number(eng.clockTick()) : Date.now();
      return _sendEvent(actorId, event, clockTick);
    },

    async getActor(actorId) {
      if (!actorId) throw new Error('actorId is required');
      return getActorState(actorId);
    },

    async terminateActor(actorId) {
      if (!actorId) throw new Error('actorId is required');
      return _terminate(actorId, { orgId });
    },

    async close() {
      try { getWorkerPool().terminate(); } catch {}
      try { if (!isPostgres) getDb().close(); } catch {}
    },
  };
}
