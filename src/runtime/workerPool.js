/**
 * src/runtime/workerPool.js
 *
 * Manages a pool of actorWorker.js threads.
 * Routes actor operations to a stable worker (hash by actorId).
 * Handles worker crash/restart transparently.
 *
 * Four-tier priority queue per worker slot:
 *   urgent — dashboard manual actions (get state, send event, terminate)
 *   high   — dashboard / interactive user actions  (X-Priority: high)
 *   normal — standard API calls (default)
 *   low    — background workers (migrate-worker, bulk ops)
 *
 * Urgent burst mode:
 *   - First URGENT_BURST_MS (5 s) of continuous urgent activity: serve urgent
 *     exclusively — all other tiers pause.
 *   - After 5 s of sustained urgent load: urgent gets 1 slot at the start of
 *     every round, then the normal 3H:2N:1L cycle runs alongside it.
 *   - Burst timer resets to null the moment the urgent queue drains.
 *
 * Tier round-robin (non-burst): 1U(post-burst) : 3H : 2N : 1L per round.
 * When lower tiers are empty the upper tiers drain freely (no starvation).
 *
 * Event coalescing: consecutive EVENT messages for the same actorId in the
 * same tier queue are batched into a single BATCH_EVENTS pass, reducing async
 * round-trips under backlog conditions.
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'actorWorker.js');

const ACTORS_PER_WORKER = parseInt(process.env.ACTORS_PER_WORKER ?? '500', 10);
const TIMEOUT_MS        = 30_000;
const HIGH_PER_ROUND    = 3;
const NORMAL_PER_ROUND  = 2;
const MAX_COALESCE      = 8;     // max consecutive EVENTs to batch per worker pass
const URGENT_BURST_MS   = 5_000; // exclusive urgent mode window before interleaving

// ── Flat queue helpers ────────────────────────────────────────────────────────

function enqueueItem(queue, item) { queue.push(item); }
function dequeueItem(queue)       { return queue.length ? queue.shift() : null; }

// ── WorkerPool ────────────────────────────────────────────────────────────────

export class WorkerPool {
  constructor(workerCount) {
    this.workerCount   = workerCount;
    this.workers       = [];
    this._shuttingDown = false;
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

      // Flat per-tier queues
      urgentQueue: [],
      highQueue:   [],
      normalQueue: [],
      lowQueue:    [],

      // Tier-level round-robin counters
      roundHigh:   0,
      roundNormal: 0,

      // Urgent burst tracking
      burstStart:            null, // Date.now() when first urgent item arrived; null when idle
      urgentServedThisRound: false, // post-burst interleave: one urgent slot per round

      stats: {
        served:  { urgent: 0, high: 0, normal: 0, low: 0 },
        waitMs:  { urgent: 0, high: 0, normal: 0, low: 0 },
        waitCnt: { urgent: 0, high: 0, normal: 0, low: 0 },
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
      if (!this._shuttingDown) this._respawn(index);
    });

    worker.on('exit', (code) => {
      if (code !== 0 && !this._shuttingDown) {
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
    for (const queue of [slot.urgentQueue, slot.highQueue, slot.normalQueue, slot.lowQueue]) {
      for (const item of queue) { clearTimeout(item.timer); item.reject(err); }
      queue.length = 0;
    }
    slot.burstStart = null;
    slot.urgentServedThisRound = false;
    slot.inFlight   = false;
  }

  /**
   * Pick and dispatch the next queued message.
   *
   * Urgent burst mode (first 5 s of continuous urgent activity):
   *   Serve urgent exclusively — all other tiers pause.
   * Post-burst (>5 s of continuous urgent):
   *   Urgent gets 1 slot at start of each round, then 3H:2N:1L proceeds normally.
   * No urgent items:
   *   Normal 3H:2N:1L weighted round-robin.
   *
   * Coalesces consecutive EVENTs for the same actorId into BATCH_EVENTS.
   */
  _scheduleNext(slot) {
    const U = slot.urgentQueue.length > 0;
    const H = slot.highQueue.length > 0;
    const N = slot.normalQueue.length > 0;
    const L = slot.lowQueue.length > 0;

    if (!U && !H && !N && !L) return;

    const now = Date.now();
    let next, tier;
    let burstActive = false;

    if (U) {
      if (slot.burstStart === null) slot.burstStart = now;
      burstActive = (now - slot.burstStart) < URGENT_BURST_MS;

      if (burstActive) {
        // Exclusive burst: urgent only, everything else pauses
        next = dequeueItem(slot.urgentQueue);
        if (next) tier = 'urgent';
      } else {
        // Post-burst: urgent gets 1 slot per round before H:N:L
        if (!slot.urgentServedThisRound) {
          next = dequeueItem(slot.urgentQueue);
          if (next) { tier = 'urgent'; slot.urgentServedThisRound = true; }
        }
      }
    } else {
      slot.burstStart            = null;
      slot.urgentServedThisRound = false;
    }

    // H:N:L round-robin — skipped entirely during burst exclusive mode
    if (!next && !burstActive) {
      if (H && slot.roundHigh < HIGH_PER_ROUND) {
        next = dequeueItem(slot.highQueue);
        if (next) { slot.roundHigh++; tier = 'high'; }
      }

      if (!next && N && slot.roundNormal < NORMAL_PER_ROUND) {
        next = dequeueItem(slot.normalQueue);
        if (next) { slot.roundNormal++; tier = 'normal'; }
      }

      if (!next) {
        // Round complete: serve low if available, else drain whatever has items.
        if (L) {
          next = dequeueItem(slot.lowQueue);
          if (next) tier = 'low';
        }
        if (!next && H) {
          next = dequeueItem(slot.highQueue);
          if (next) tier = 'high';
        }
        if (!next && N) {
          next = dequeueItem(slot.normalQueue);
          if (next) tier = 'normal';
        }
        slot.roundHigh             = 0;
        slot.roundNormal           = 0;
        slot.urgentServedThisRound = false;
      }
    }

    if (!next) return;

    const waitMs = Date.now() - next.queuedAt;
    slot.stats.served[tier]++;
    slot.stats.waitMs[tier]  += waitMs;
    slot.stats.waitCnt[tier]++;

    // Coalesce consecutive EVENTs for same actorId from the same tier queue
    if (next.message.type === 'EVENT') {
      const actorId = next.message.actorId;
      const queue   =
        tier === 'urgent' ? slot.urgentQueue :
        tier === 'high'   ? slot.highQueue   :
        tier === 'normal' ? slot.normalQueue : slot.lowQueue;
      const batch   = [next];

      while (
        batch.length < MAX_COALESCE &&
        queue.length > 0 &&
        queue[0].message.type === 'EVENT' &&
        queue[0].message.actorId === actorId
      ) {
        const extra = queue.shift();
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
   * Send a message directly to a specific worker slot, bypassing the actorId hash.
   * Used for broadcast operations like PRECOMPILE where every worker must receive the message.
   */
  sendToSlot(slotIndex, message) {
    const slot = this.workers[slotIndex];
    if (!slot) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.pending.delete(id);
        reject(new Error(`Worker timeout for ${message.type} on slot ${slotIndex}`));
      }, TIMEOUT_MS);
      if (!slot.inFlight) {
        slot.inFlight = true;
        slot.pending.set(id, { resolve, reject, timer });
        slot.worker.postMessage({ ...message, id });
      } else {
        const item = { id, message, resolve, reject, timer, queuedAt: Date.now() };
        enqueueItem(slot.normalQueue, item);
      }
    });
  }

  /**
   * Send a message to the worker responsible for actorId.
   * @param {string}  actorId
   * @param {object}  message
   * @param {object}  [opts]
   * @param {string}  [opts.priority='normal']  'urgent' | 'high' | 'normal' | 'low'
   * @returns {Promise}
   */
  send(actorId, message, { priority = 'normal' } = {}) {
    const slot = this.workers[this._slotFor(actorId)];
    if (!slot) throw new Error('No worker available');

    const id   = randomUUID();
    const tier =
      priority === 'urgent' ? 'urgent' :
      priority === 'high'   ? 'high'   :
      priority === 'low'    ? 'low'    : 'normal';

    return new Promise((resolve, reject) => {
      const queuedAt = Date.now();
      const timer = setTimeout(() => {
        slot.pending.delete(id);
        for (const queue of [slot.urgentQueue, slot.highQueue, slot.normalQueue, slot.lowQueue]) {
          const idx = queue.findIndex(i => i.id === id);
          if (idx !== -1) { queue.splice(idx, 1); break; }
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
        const item  = { id, message, resolve, reject, timer, queuedAt };
        const queue =
          tier === 'urgent' ? slot.urgentQueue :
          tier === 'high'   ? slot.highQueue   :
          tier === 'low'    ? slot.lowQueue    : slot.normalQueue;
        enqueueItem(queue, item);
      }
    });
  }

  /** Aggregate queue depth, throughput, and wait-time stats across all workers. */
  getQueueStats() {
    const perWorker = this.workers.map((slot, i) => ({
      index:    i,
      inFlight: slot.inFlight,
      burstActive: slot.burstStart !== null && (Date.now() - slot.burstStart) < URGENT_BURST_MS,
      queued: {
        urgent: slot.urgentQueue.length,
        high:   slot.highQueue.length,
        normal: slot.normalQueue.length,
        low:    slot.lowQueue.length,
      },
      served: { ...slot.stats.served },
      avgWaitMs: {
        urgent: slot.stats.waitCnt.urgent > 0 ? Math.round(slot.stats.waitMs.urgent / slot.stats.waitCnt.urgent) : 0,
        high:   slot.stats.waitCnt.high   > 0 ? Math.round(slot.stats.waitMs.high   / slot.stats.waitCnt.high)   : 0,
        normal: slot.stats.waitCnt.normal > 0 ? Math.round(slot.stats.waitMs.normal / slot.stats.waitCnt.normal) : 0,
        low:    slot.stats.waitCnt.low    > 0 ? Math.round(slot.stats.waitMs.low    / slot.stats.waitCnt.low)    : 0,
      },
    }));

    const totQueued  = { urgent: 0, high: 0, normal: 0, low: 0 };
    const totServed  = { urgent: 0, high: 0, normal: 0, low: 0 };
    const totWaitMs  = { urgent: 0, high: 0, normal: 0, low: 0 };
    const totWaitCnt = { urgent: 0, high: 0, normal: 0, low: 0 };

    for (const slot of this.workers) {
      totQueued.urgent += slot.urgentQueue.length;
      totQueued.high   += slot.highQueue.length;
      totQueued.normal += slot.normalQueue.length;
      totQueued.low    += slot.lowQueue.length;
      for (const t of ['urgent', 'high', 'normal', 'low']) {
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
          urgent: totWaitCnt.urgent > 0 ? Math.round(totWaitMs.urgent / totWaitCnt.urgent) : 0,
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
    this._shuttingDown = true;
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
    const explicitCount = parseInt(process.env.STATEKEEP_WORKER_COUNT ?? '0', 10);
    const cpuDefault    = Math.max(4, Math.min(32, os.cpus().length));
    const maxActors     = parseInt(process.env.HOT_REGISTRY_SIZE ?? '10000', 10);
    const legacyCount   = (maxActors > 0 && ACTORS_PER_WORKER > 0) ? Math.ceil(maxActors / ACTORS_PER_WORKER) : 0;
    const count         = explicitCount || Math.max(cpuDefault, legacyCount);
    _pool = new WorkerPool(count);
    console.log(`[workerPool] Started ${count} actor workers (cpu=${os.cpus().length}, 1U(burst 5s):${HIGH_PER_ROUND}H:${NORMAL_PER_ROUND}N:1L round-robin)`);
  }
  return _pool;
}

export default { getWorkerPool };
