/**
 * src/ffi/engine.js
 *
 * Loads the APV engine from the pre-built WebAssembly module (apv-engine.mjs, which
 * embeds the binary). See src/ffi/Makefile for how it is built.
 *
 * All uint64 values cross the JS/WASM boundary as BigInt.
 *
 * Scopes: every change-point is registered in the scope of its workflow family
 * (scopeOf(machineId)) and every lookup asks in the actor's family scope, so one
 * workflow's deployment can never answer — or hide — another workflow's lookup.
 * Scope 0n is the engine's original, unscoped registry.
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_BUFFER_SIZE = 512;

/** The engine scope of a workflow family: 64-bit FNV-1a of its machine id (never 0). */
export function scopeOf(machineId) {
  if (machineId == null || machineId === '') return 0n;
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(String(machineId), 'utf8')) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h === 0n ? 1n : h;
}

function regionHashesToBuffer(rHashes) {
  const buf = Buffer.alloc(rHashes.length * 8, 0);
  for (let i = 0; i < rHashes.length; i++) buf.writeBigUInt64LE(BigInt(rHashes[i]), i * 8);
  return buf;
}

async function loadEngine() {
  const mjsPath = join(__dirname, 'apv-engine.mjs');
  if (!existsSync(mjsPath)) {
    throw new Error(
      '[ffi/engine] WASM engine not built.\n' +
      '  Run: make wasm -C src/ffi   (requires Emscripten — https://emscripten.org)'
    );
  }

  const { default: createModule } = await import('./apv-engine.mjs');
  const wasm = await createModule();
  const reg  = wasm._apv_registry_create();
  if (!reg) throw new Error('[ffi/engine] apv_registry_create() returned null');

  console.log('[ffi/engine] Loaded WASM APV engine');

  // WASM memory is a flat ArrayBuffer; toPtr copies the buffer onto the WASM heap where C functions can read it
  // strPtr null-terminates the string first — C's strlen/strcmp expect a '\0' sentinel
  function toPtr(buf) {
    const ptr = wasm._malloc(buf.length);
    new Uint8Array(wasm.HEAPU8.buffer).set(buf, ptr);
    return ptr;
  }

  function strPtr(str) {
    return toPtr(new TextEncoder().encode(str + '\0'));
  }

  // JS-side count of registered change-points. actorManager's inline migration
  // check fast-exits when this is 0; without it the check was skipped forever.
  let changepoints = 0;
  // Engine builds with scopes and an O(1) clock restore (all current builds).
  const scoped = typeof wasm._apv_register_changepoint_scoped === 'function'
              && typeof wasm._apv_clock_advance_to === 'function';

  return {
    available: true,
    mode: 'wasm',
    scoped,

    changepointCount() { return changepoints; },

    clockTick() { return wasm._apv_clock_tick(reg); },
    /** Current clock value without advancing it. */
    clockNow() { return scoped ? wasm._apv_clock_now(reg) : null; },
    /** Make every future tick later than t (restores the clock after a restart). */
    advanceClockTo(t) {
      const target = BigInt(t);
      if (scoped) return wasm._apv_clock_advance_to(reg, target);
      let cur = BigInt(wasm._apv_clock_tick(reg));           // older engine builds: tick up to it
      while (cur < target) cur = BigInt(wasm._apv_clock_tick(reg));
      return cur;
    },
    fnv1aInit() { return wasm._apv_fnv1a_init(); },
    fnv1aFinal(h) { return wasm._apv_fnv1a_final(BigInt(h)); },

    fnv1aUpdate(hash, data) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      const p = toPtr(buf);
      try   { return wasm._apv_fnv1a_update(BigInt(hash), p, buf.length); }
      finally { wasm._free(p); }
    },

    registerChangepoint(tStar, pH, ref, cid, scope = 0n) {
      const p = strPtr(cid);
      try {
        const rc = scoped
          ? wasm._apv_register_changepoint_scoped(reg, BigInt(scope), BigInt(tStar), BigInt(pH), BigInt(ref), p)
          : wasm._apv_register_changepoint(reg, BigInt(tStar), BigInt(pH), BigInt(ref), p);
        if (rc === 0) changepoints++;
        return rc;
      } finally { wasm._free(p); }
    },

    computeAccessible(pH, logT, curT, scope = 0n) {
      const out = wasm._malloc(OUTPUT_BUFFER_SIZE);
      try {
        const rc = scoped
          ? wasm._apv_compute_accessible_scoped(reg, BigInt(scope), BigInt(pH), BigInt(logT), BigInt(curT), out, OUTPUT_BUFFER_SIZE)
          : wasm._apv_compute_accessible(reg, BigInt(pH), BigInt(logT), BigInt(curT), out, OUTPUT_BUFFER_SIZE);
        if (rc !== 1) return null;
        const s = wasm.UTF8ToString(out, OUTPUT_BUFFER_SIZE);
        return s.length > 0 ? s : null;
      } finally { wasm._free(out); }
    },

    /** Extended build: lookups that also report the hit's t* (and matched key). */
    hasEx: typeof wasm._apv_compute_accessible_scoped_ex === 'function',

    /** Scalar lookup → { target, tStar, key } or null. key is 0n when the wildcard matched. */
    computeAccessibleEx(pH, logT, curT, scope = 0n) {
      if (typeof wasm._apv_compute_accessible_scoped_ex !== 'function') {
        const target = this.computeAccessible(pH, logT, curT, scope);
        return target ? { target, tStar: null, key: null } : null;
      }
      const out = wasm._malloc(OUTPUT_BUFFER_SIZE + 16);
      const tp = out + OUTPUT_BUFFER_SIZE, kp = tp + 8;
      try {
        const rc = wasm._apv_compute_accessible_scoped_ex(reg, BigInt(scope), BigInt(pH), BigInt(logT), BigInt(curT), out, OUTPUT_BUFFER_SIZE, tp, kp);
        if (rc !== 1) return null;
        const dv = new DataView(wasm.HEAPU8.buffer);
        const target = wasm.UTF8ToString(out, OUTPUT_BUFFER_SIZE);
        if (!target) return null;
        return { target, tStar: dv.getBigUint64(tp, true), key: dv.getBigUint64(kp, true) };
      } finally { wasm._free(out); }
    },

    /** Parallel lookup → { target, tStar } or null. */
    computeAccessibleParallelEx(rHashes, logT, curT, scope = 0n) {
      if (typeof wasm._apv_compute_accessible_parallel_scoped_ex !== 'function') {
        const target = this.computeAccessibleParallel(rHashes, logT, curT, scope);
        return target ? { target, tStar: null } : null;
      }
      const rp  = toPtr(regionHashesToBuffer(rHashes));
      const out = wasm._malloc(OUTPUT_BUFFER_SIZE + 8);
      const tp = out + OUTPUT_BUFFER_SIZE;
      try {
        const rc = wasm._apv_compute_accessible_parallel_scoped_ex(reg, BigInt(scope), rp, rHashes.length, BigInt(logT), BigInt(curT), out, OUTPUT_BUFFER_SIZE, tp);
        if (rc !== 1) return null;
        const target = wasm.UTF8ToString(out, OUTPUT_BUFFER_SIZE);
        if (!target) return null;
        return { target, tStar: new DataView(wasm.HEAPU8.buffer).getBigUint64(tp, true) };
      } finally { wasm._free(rp); wasm._free(out); }
    },

    /** Remove every change-point of `scope` with t* < frontier. Returns the count, or -1. */
    collectBefore(scope, frontier) {
      if (typeof wasm._apv_collect_before_scoped !== 'function') return -1;
      const n = Number(wasm._apv_collect_before_scoped(reg, BigInt(scope), BigInt(frontier)));
      if (n > 0) changepoints = Math.max(0, changepoints - n);
      return n;
    },

    actorStarted(tStar, pH)  { wasm._apv_actor_started(reg, BigInt(tStar), BigInt(pH)); },
    actorStopped(tStar, pH)  { wasm._apv_actor_stopped(reg, BigInt(tStar), BigInt(pH)); },
    vacatePrefix(tStar, pH)  { wasm._apv_vacate_prefix(reg, BigInt(tStar), BigInt(pH)); },

    registerChangepointParallel(tStar, rHashes, ref, cid, scope = 0n) {
      const rp = toPtr(regionHashesToBuffer(rHashes));
      const sp = strPtr(cid);
      try {
        const rc = scoped
          ? wasm._apv_register_changepoint_parallel_scoped(reg, BigInt(scope), BigInt(tStar), rp, rHashes.length, BigInt(ref), sp)
          : wasm._apv_register_changepoint_parallel(reg, BigInt(tStar), rp, rHashes.length, BigInt(ref), sp);
        if (rc === 0) changepoints++;
        return rc;
      } finally { wasm._free(rp); wasm._free(sp); }
    },

    computeAccessibleParallel(rHashes, logT, curT, scope = 0n) {
      const rp  = toPtr(regionHashesToBuffer(rHashes));
      const out = wasm._malloc(OUTPUT_BUFFER_SIZE);
      try {
        const rc = scoped
          ? wasm._apv_compute_accessible_parallel_scoped(reg, BigInt(scope), rp, rHashes.length, BigInt(logT), BigInt(curT), out, OUTPUT_BUFFER_SIZE)
          : wasm._apv_compute_accessible_parallel(reg, rp, rHashes.length, BigInt(logT), BigInt(curT), out, OUTPUT_BUFFER_SIZE);
        if (rc !== 1) return null;
        const s = wasm.UTF8ToString(out, OUTPUT_BUFFER_SIZE);
        return s.length > 0 ? s : null;
      } finally { wasm._free(rp); wasm._free(out); }
    },

    destroy() { try { wasm._apv_registry_destroy(reg); } catch {} },
  };
}

// No runtime fallback: if apv-engine.mjs is absent loadEngine() throws and the server fails to start
let engineSingleton = null;
export const engineReady = loadEngine().then(e => { engineSingleton = e; });

export function getEngine() {
  if (!engineSingleton) throw new Error('[ffi/engine] Engine not loaded — await engineReady first.');
  return engineSingleton;
}

export default { getEngine, engineReady };
