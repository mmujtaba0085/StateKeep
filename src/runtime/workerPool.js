/**
 * src/runtime/workerPool.js
 *
 * Manages a pool of actorWorker.js threads.
 * Routes actor operations to a stable worker (hash by actorId).
 * Handles worker crash/restart transparently.
 *
 * Three-tier priority queue per worker slot, with per-org fairness:
 *   high   — dashboard / interactive user actions  (X-Priority: high)
 *   normal — standard API calls (default)
 *   low    — background workers (migrate-worker, bulk ops)
 *
 * Within each tier, round-robins across orgIds so one org's backlog
 * cannot starve another org's requests at the same priority level.
 *
 * Tier round-robin: HIGH_PER_ROUND(3) : NORMAL_PER_ROUND(2) : 1 low per round.
 * When lower tiers are empty the upper tiers drain freely (no starvation).
 *
 * Event coalescing: consecutive EVENT messages for the same actorId from the
 * same org queue are batched into a single BATCH_EVENTS pass, reducing async
 * round-trips under backlog conditions.
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'actorWorker.js');

const ACTORS_PER_WORKER = parseInt(process.env.ACTORS_PER_WORKER ?? '500', 10);
const TIMEOUT_MS        = 30_000;
const HIGH_PER_ROUND    = 3;
const NORMAL_PER_ROUND  = 2;
const MAX_COALESCE      = 8;   // max consecutive EVENTs to batch per worker pass

// ── Per-tier, per-org queue helpers ──────────────────────────────────────────

function enqueueItem(queues, orgs, orgId, item) {
  if (!queues.has(orgId)) {
    queues.set(orgId, []);
    orgs.push(orgId);
  }
  queues.get(orgId).push(item);
}

/**
 * Dequeue the next item from a tier using round-robin across orgs.
 * Returns null when all org queues in the tier are empty.
 */
function dequeueItem(queues, orgs, cursorRef) {
  if (orgs.length === 0) return null;
  for (let i = 0; i < orgs.length; i++) {
    const idx   = (cursorRef.value + i) % orgs.length;
    const orgId = orgs[idx];
    const q     = queues.get(orgId);
    if (q && q.length > 0) {
      cursorRef.value = (idx + 1) % orgs.length;
      return q.shift();
    }
  }
  return null;
}

function hasTierItems(queues) {
  for (const q of queues.values()) {
    if (q.length > 0) return true;
  }
  return false;
}

function tierDepth(queues) {
  let n = 0;
  for (const q of queues.values()) n += q.length;
  return n;
}

// ── WorkerPool ────────────────────────────────────────────────────────────────

export class WorkerPool {
  constructor(workerCount) {
    this.workerCount = workerCount;
    this.workers     = [];
    this._init();
  }

  _init() {
    for (let i = 0; i < this.workerCount; i++) {
      this._spawnWorker(i);
    }
  }

  _spawnWorker(index) {
    const worker = new Worker(WORKER_PATH);
    const slot   = {
      worker,
      pending:     new Map(),
      index,
      ready:       false,
      inFlight:    false,

      // Per-tier, per-org queues: Map<orgId, item[]>
      highQueues:   new Map(),
      normalQueues: new Map(),
      lowQueues:    new Map(),

      // Ordered list of org IDs seen per tier (insertion order = round-robin start)
      highOrgs:   [],
      normalOrgs: [],
      lowOrgs:    [],

      // Round-robin org cursor per tier
      highOrgIdx:   { value: 0 },
      normalOrgIdx: { value: 0 },
      lowOrgIdx:    { value: 0 },

      // Tier-level round-robin counters
      roundHigh:   0,
      roundNormal: 0,

      stats: {
        served:  { high: 0, normal: 0, low: 0 },
        waitMs:  { high: 0, normal: 0, low: 0 },
        waitCnt: { high: 0, normal: 0, low: 0 },
      },
    };

    worker.on('message', (msg) => {
      if (msg.id === '__ready__') { slot.ready = true; return; }
      const p = slot.pending.get(msg.id);
      if (!p) return;
      slot.pending.delete(msg.id);
      slot.inFlight = false;

      if (p.type === 'batch') {
        if (msg.ok) {
          p.items.forEach((item, i) => {
            clearTimeout(item.timer);
            item.resolve(msg.result.results[i]);
          });
        } else {
          p.items.forEach(item => {
            clearTimeout(item.timer);
            item.reject(new Error(msg.error ?? 'Worker error'));
          });
        }
      } else {
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else        p.reject(new Error(msg.error ?? 'Worker error'));
      }
      this._scheduleNext(slot);
    });

    worker.on('error', (err) => {
      console.error(`[workerPool] Worker ${index} error:`, err);
      this._rejectAll(slot, err);
      this._respawn(index);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[workerPool] Worker ${index} exited with code ${code}`);
        this._rejectAll(slot, new Error(`Worker exited: ${code}`));
        this._respawn(index);
      }
    });

    this.workers[index] = slot;
  }

  _respawn(index) {
    console.log(`[workerPool] Respawning worker ${index}`);
    setTimeout(() => this._spawnWorker(index), 1000);
  }

  _rejectAll(slot, err) {
    for (const [, p] of slot.pending) {
      if (p.type === 'batch') {
        p.items.forEach(item => { clearTimeout(item.timer); item.reject(err); });
      } else {
        clearTimeout(p.timer);
        p.reject(err);
      }
    }
    slot.pending.clear();
    for (const queues of [slot.highQueues, slot.normalQueues, slot.lowQueues]) {
      for (const q of queues.values()) {
        for (const item of q) { clearTimeout(item.timer); item.reject(err); }
      }
      queues.clear();
    }
    slot.highOrgs   = [];
    slot.normalOrgs = [];
    slot.lowOrgs    = [];
    slot.inFlight   = false;
  }

  /**
   * Pick and dispatch the next queued message.
   * Tier selection: 3-tier weighted round-robin (H:N:L = 3:2:1).
   * Within each tier: round-robin across org queues for fairness.
   * Coalesces consecutive EVENTs for the same actorId+orgId into BATCH_EVENTS.
   */
  _scheduleNext(slot) {
    const H = hasTierItems(slot.highQueues);
    const N = hasTierItems(slot.normalQueues);
    const L = hasTierItems(slot.lowQueues);

    if (!H && !N && !L) return;

    let next;
    let tier;

    if (H && slot.roundHigh < HIGH_PER_ROUND) {
      next = dequeueItem(slot.highQueues, slot.highOrgs, slot.highOrgIdx);
      if (next) { slot.roundHigh++; tier = 'high'; }
    }

    if (!next && N && slot.roundNormal < NORMAL_PER_ROUND) {
      next = dequeueItem(slot.normalQueues, slot.normalOrgs, slot.normalOrgIdx);
      if (next) { slot.roundNormal++; tier = 'normal'; }
    }

    if (!next) {
      // Round complete: serve low if available, else drain whatever has items.
      if (L) {
        next = dequeueItem(slot.lowQueues, slot.lowOrgs, slot.lowOrgIdx);
        if (next) tier = 'low';
      }
      if (!next && H) {
        next = dequeueItem(slot.highQueues, slot.highOrgs, slot.highOrgIdx);
        if (next) tier = 'high';
      }
      if (!next && N) {
        next = dequeueItem(slot.normalQueues, slot.normalOrgs, slot.normalOrgIdx);
        if (next) tier = 'normal';
      }
      slot.roundHigh   = 0;
      slot.roundNormal = 0;
    }

    if (!next) return;

    const waitMs = Date.now() - next.queuedAt;
    slot.stats.served[tier]++;
    slot.stats.waitMs[tier]  += waitMs;
    slot.stats.waitCnt[tier]++;

    // Coalesce consecutive EVENTs for same actorId from the same org queue
    if (next.message.type === 'EVENT') {
      const actorId  = next.message.actorId;
      const orgId    = next.orgId;
      const queues   = tier === 'high' ? slot.highQueues : tier === 'normal' ? slot.normalQueues : slot.lowQueues;
      const orgQueue = queues.get(orgId);
      const batch    = [next];

      while (
        batch.length < MAX_COALESCE &&
        orgQueue && orgQueue.length > 0 &&
        orgQueue[0].message.type === 'EVENT' &&
        orgQueue[0].message.actorId === actorId
      ) {
        const extra = orgQueue.shift();
        const ew = Date.now() - extra.queuedAt;
        slot.stats.served[tier]++;
        slot.stats.waitMs[tier]  += ew;
        slot.stats.waitCnt[tier]++;
        batch.push(extra);
      }

      if (batch.length > 1) {
        slot.inFlight = true;
        const batchId = randomUUID();
        slot.pending.set(batchId, {
          type:  'batch',
          items: batch.map(i => ({ resolve: i.resolve, reject: i.reject, timer: i.timer })),
        });
        slot.worker.postMessage({
          type:   'BATCH_EVENTS',
          id:     batchId,
          actorId,
          events: batch.map(i => ({
            event:              i.message.event,
            historyFingerprint: i.message.historyFingerprint,
            regionFingerprints: i.message.regionFingerprints ?? null,
          })),
        });
        return;
      }
    }

    slot.inFlight = true;
    slot.pending.set(next.id, { resolve: next.resolve, reject: next.reject, timer: next.timer });
    slot.worker.postMessage({ ...next.message, id: next.id });
  }

  /** Route an actorId to a deterministic worker slot. */
  _slotFor(actorId) {
    let h = 0;
    for (let i = 0; i < actorId.length; i++) {
      h = ((h << 5) - h + actorId.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % this.workerCount;
  }

  /**
   * Send a message to the worker responsible for actorId.
   * @param {string}  actorId
   * @param {object}  message
   * @param {object}  [opts]
   * @param {string}  [opts.priority='normal']  'high' | 'normal' | 'low'
   * @param {string}  [opts.orgId='_system']    org namespace for fairness isolation
   * @returns {Promise}
   */
  send(actorId, message, { priority = 'normal', orgId = '_system' } = {}) {
    const slot = this.workers[this._slotFor(actorId)];
    if (!slot) throw new Error('No worker available');

    const id   = randomUUID();
    const tier = priority === 'high' ? 'high' : priority === 'low' ? 'low' : 'normal';

    return new Promise((resolve, reject) => {
      const queuedAt = Date.now();
      const timer = setTimeout(() => {
        slot.pending.delete(id);
        for (const queues of [slot.highQueues, slot.normalQueues, slot.lowQueues]) {
          for (const q of queues.values()) {
            const idx = q.findIndex(i => i.id === id);
            if (idx !== -1) { q.splice(idx, 1); break; }
          }
        }
        reject(new Error(`Worker timeout for ${message.type} on ${actorId}`));
      }, TIMEOUT_MS);

      if (!slot.inFlight) {
        const waitMs = Date.now() - queuedAt;
        slot.stats.served[tier]++;
        slot.stats.waitMs[tier]  += waitMs;
        slot.stats.waitCnt[tier]++;
        slot.inFlight = true;
        slot.pending.set(id, { resolve, reject, timer });
        slot.worker.postMessage({ ...message, id });
      } else {
        const item = { id, message, resolve, reject, timer, queuedAt, orgId };
        const queues = tier === 'high' ? slot.highQueues : tier === 'low' ? slot.lowQueues : slot.normalQueues;
        const orgs   = tier === 'high' ? slot.highOrgs   : tier === 'low' ? slot.lowOrgs   : slot.normalOrgs;
        enqueueItem(queues, orgs, orgId, item);
      }
    });
  }

  /** Aggregate queue depth, throughput, and wait-time stats across all workers. */
  getQueueStats() {
    const perWorker = this.workers.map((slot, i) => ({
      index:    i,
      inFlight: slot.inFlight,
      queued: {
        high:   tierDepth(slot.highQueues),
        normal: tierDepth(slot.normalQueues),
        low:    tierDepth(slot.lowQueues),
      },
      served: { ...slot.stats.served },
      avgWaitMs: {
        high:   slot.stats.waitCnt.high   > 0 ? Math.round(slot.stats.waitMs.high   / slot.stats.waitCnt.high)   : 0,
        normal: slot.stats.waitCnt.normal > 0 ? Math.round(slot.stats.waitMs.normal / slot.stats.waitCnt.normal) : 0,
        low:    slot.stats.waitCnt.low    > 0 ? Math.round(slot.stats.waitMs.low    / slot.stats.waitCnt.low)    : 0,
      },
    }));

    const totQueued  = { high: 0, normal: 0, low: 0 };
    const totServed  = { high: 0, normal: 0, low: 0 };
    const totWaitMs  = { high: 0, normal: 0, low: 0 };
    const totWaitCnt = { high: 0, normal: 0, low: 0 };

    for (const slot of this.workers) {
      totQueued.high   += tierDepth(slot.highQueues);
      totQueued.normal += tierDepth(slot.normalQueues);
      totQueued.low    += tierDepth(slot.lowQueues);
      for (const t of ['high', 'normal', 'low']) {
        totServed[t]  += slot.stats.served[t];
        totWaitMs[t]  += slot.stats.waitMs[t];
        totWaitCnt[t] += slot.stats.waitCnt[t];
      }
    }

    return {
      workerCount: this.workerCount,
      perWorker,
      totals: {
        queued: totQueued,
        served: totServed,
        avgWaitMs: {
          high:   totWaitCnt.high   > 0 ? Math.round(totWaitMs.high   / totWaitCnt.high)   : 0,
          normal: totWaitCnt.normal > 0 ? Math.round(totWaitMs.normal / totWaitCnt.normal) : 0,
          low:    totWaitCnt.low    > 0 ? Math.round(totWaitMs.low    / totWaitCnt.low)    : 0,
        },
      },
    };
  }

  async ping() {
    const results = await Promise.allSettled(
      this.workers.map((slot, i) =>
        this.send(`__ping__${i}`, { type: 'PING', actorId: `__ping__${i}` })
      )
    );
    return results.map((r, i) => ({
      index:  i,
      alive:  r.status === 'fulfilled',
      detail: r.status === 'fulfilled' ? r.value : r.reason?.message,
    }));
  }

  terminate() {
    for (const slot of this.workers) {
      try { slot.worker.terminate(); } catch {}
    }
  }

  restartAll() {
    for (let i = 0; i < this.workers.length; i++) {
      const slot = this.workers[i];
      this._rejectAll(slot, new Error('Worker restarting'));
      try { slot.worker.terminate(); } catch {}
    }
    this.workers = [];
    this._init();
    console.log(`[workerPool] All ${this.workerCount} actor workers restarted`);
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _pool = null;

export function getWorkerPool() {
  if (!_pool) {
    const maxActors = parseInt(process.env.HOT_REGISTRY_SIZE ?? '10000', 10);
    const count     = Math.max(1, Math.ceil(maxActors / ACTORS_PER_WORKER));
    _pool = new WorkerPool(count);
    console.log(`[workerPool] Started ${count} actor workers (${ACTORS_PER_WORKER} actors/worker, ${HIGH_PER_ROUND}H:${NORMAL_PER_ROUND}N:1L per-org round-robin)`);
  }
  return _pool;
}

export default { getWorkerPool };
