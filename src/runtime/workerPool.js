/**
 * src/runtime/workerPool.js
 *
 * Manages a pool of actorWorker.js threads.
 * Routes actor operations to a stable worker (hash by actorId).
 * Handles worker crash/restart transparently.
 *
 * Priority scheduling: each worker slot has two queues (high / normal).
 * Weighted round-robin: 3 high-priority messages are dequeued for every
 * 1 normal-priority message when both queues are non-empty.
 * This prevents starvation: sim/batch traffic keeps moving, but
 * interactive (dashboard) events are processed first.
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'actorWorker.js');

const ACTORS_PER_WORKER = parseInt(process.env.ACTORS_PER_WORKER ?? '500', 10);
const TIMEOUT_MS        = 30_000;
const HIGH_PER_ROUND    = 3;   // high-priority slots per 1 normal-priority slot

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
      pending:             new Map(),   // id → { resolve, reject, timer }
      index,
      ready:               false,
      inFlight:            false,       // is the worker currently processing?
      highQueue:           [],          // { id, message, resolve, reject, timer }
      normalQueue:         [],
      highServedSinceNormal: 0,
    };

    worker.on('message', (msg) => {
      if (msg.id === '__ready__') { slot.ready = true; return; }
      const p = slot.pending.get(msg.id);
      if (!p) return;
      slot.pending.delete(msg.id);
      clearTimeout(p.timer);
      slot.inFlight = false;
      if (msg.ok) p.resolve(msg.result);
      else        p.reject(new Error(msg.error ?? 'Worker error'));
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
      clearTimeout(p.timer);
      p.reject(err);
    }
    slot.pending.clear();
    for (const item of slot.highQueue)   { clearTimeout(item.timer); item.reject(err); }
    for (const item of slot.normalQueue) { clearTimeout(item.timer); item.reject(err); }
    slot.highQueue   = [];
    slot.normalQueue = [];
    slot.inFlight    = false;
  }

  /**
   * Dequeue the next message using weighted round-robin:
   *   - If only one queue has items: drain it.
   *   - If both have items: serve HIGH_PER_ROUND high items per 1 normal item.
   */
  _scheduleNext(slot) {
    const hasHigh   = slot.highQueue.length > 0;
    const hasNormal = slot.normalQueue.length > 0;

    if (!hasHigh && !hasNormal) return;   // both empty — worker idles

    let next;
    if (hasHigh && !hasNormal) {
      next = slot.highQueue.shift();
    } else if (hasNormal && !hasHigh) {
      next = slot.normalQueue.shift();
      slot.highServedSinceNormal = 0;
    } else {
      // Both non-empty: weighted round-robin
      if (slot.highServedSinceNormal < HIGH_PER_ROUND) {
        next = slot.highQueue.shift();
        slot.highServedSinceNormal++;
      } else {
        next = slot.normalQueue.shift();
        slot.highServedSinceNormal = 0;
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
   * @param {string}  [opts.priority='normal']  'high' | 'normal'
   * @returns {Promise}
   */
  send(actorId, message, { priority = 'normal' } = {}) {
    const slot = this.workers[this._slotFor(actorId)];
    if (!slot) throw new Error('No worker available');

    const id = randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.pending.delete(id);
        // also remove from queues if still waiting
        slot.highQueue   = slot.highQueue.filter(i => i.id !== id);
        slot.normalQueue = slot.normalQueue.filter(i => i.id !== id);
        reject(new Error(`Worker timeout for ${message.type} on ${actorId}`));
      }, TIMEOUT_MS);

      if (!slot.inFlight) {
        // Worker is idle — dispatch immediately
        slot.inFlight = true;
        slot.pending.set(id, { resolve, reject, timer });
        slot.worker.postMessage({ ...message, id });
      } else {
        // Worker is busy — enqueue
        const item = { id, message, resolve, reject, timer };
        if (priority === 'high') {
          slot.highQueue.push(item);
        } else {
          slot.normalQueue.push(item);
        }
      }
    });
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
    console.log(`[workerPool] Started ${count} actor workers (${ACTORS_PER_WORKER} actors/worker)`);
  }
  return _pool;
}

export default { getWorkerPool };
