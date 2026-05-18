/**
 * src/runtime/workerPool.js
 *
 * Manages a pool of actorWorker.js threads.
 * Routes actor operations to a stable worker (hash by actorId).
 * Handles worker crash/restart transparently.
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'actorWorker.js');

const ACTORS_PER_WORKER = parseInt(process.env.ACTORS_PER_WORKER ?? '500', 10);
const TIMEOUT_MS        = 30_000;

export class WorkerPool {
  constructor(workerCount) {
    this.workerCount = workerCount;
    this.workers     = [];   // Array<{ worker: Worker, pending: Map }>
    this._init();
  }

  _init() {
    for (let i = 0; i < this.workerCount; i++) {
      this._spawnWorker(i);
    }
  }

  _spawnWorker(index) {
    const worker = new Worker(WORKER_PATH);
    const slot   = { worker, pending: new Map(), index, ready: false };

    worker.on('message', (msg) => {
      if (msg.id === '__ready__') { slot.ready = true; return; }
      const p = slot.pending.get(msg.id);
      if (!p) return;
      slot.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else        p.reject(new Error(msg.error ?? 'Worker error'));
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
  }

  /**
   * Route an actorId to a deterministic worker slot.
   */
  _slotFor(actorId) {
    let h = 0;
    for (let i = 0; i < actorId.length; i++) {
      h = ((h << 5) - h + actorId.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % this.workerCount;
  }

  /**
   * Send a message to the worker responsible for actorId.
   * Returns a Promise that resolves with the worker's result.
   */
  send(actorId, message) {
    const slot = this.workers[this._slotFor(actorId)];
    if (!slot) throw new Error('No worker available');

    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.pending.delete(id);
        reject(new Error(`Worker timeout for ${message.type} on ${actorId}`));
      }, TIMEOUT_MS);

      slot.pending.set(id, { resolve, reject, timer });
      slot.worker.postMessage({ ...message, id });
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
    const maxActors  = parseInt(process.env.HOT_REGISTRY_SIZE ?? '10000', 10);
    const count      = Math.max(1, Math.ceil(maxActors / ACTORS_PER_WORKER));
    _pool = new WorkerPool(count);
    console.log(`[workerPool] Started ${count} actor workers (${ACTORS_PER_WORKER} actors/worker)`);
  }
  return _pool;
}

export default { getWorkerPool };
