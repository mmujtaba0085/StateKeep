/**
 * src/ffi/engine.js
 *
 * Loads the APV engine from the pre-built WASM binary (apv-engine.mjs +
 * apv-engine.wasm), compiled from apv-engine-fixed.c via Emscripten.
 *
 * Build: make wasm -C src/ffi
 *
 * All uint64 values cross the JS/WASM boundary as BigInt (WASM_BIGINT=1).
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_BUFFER_SIZE = 512;

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

  function toPtr(buf) {
    const ptr = wasm._malloc(buf.length);
    new Uint8Array(wasm.HEAPU8.buffer).set(buf, ptr);
    return ptr;
  }

  function strPtr(str) {
    return toPtr(new TextEncoder().encode(str + '\0'));
  }

  return {
    available: true,
    mode: 'wasm',

    clockTick() { return wasm._apv_clock_tick(reg); },
    fnv1aInit() { return wasm._apv_fnv1a_init(); },
    fnv1aFinal(h) { return wasm._apv_fnv1a_final(BigInt(h)); },

    fnv1aUpdate(hash, data) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      const p = toPtr(buf);
      try   { return wasm._apv_fnv1a_update(BigInt(hash), p, buf.length); }
      finally { wasm._free(p); }
    },

    registerChangepoint(tStar, pH, ref, cid) {
      const p = strPtr(cid);
      try   { return wasm._apv_register_changepoint(reg, BigInt(tStar), BigInt(pH), BigInt(ref), p); }
      finally { wasm._free(p); }
    },

    computeAccessible(pH, logT, curT) {
      const out = wasm._malloc(OUTPUT_BUFFER_SIZE);
      try {
        const rc = wasm._apv_compute_accessible(reg, BigInt(pH), BigInt(logT), BigInt(curT), out, OUTPUT_BUFFER_SIZE);
        if (rc !== 1) return null;
        const s = wasm.UTF8ToString(out, OUTPUT_BUFFER_SIZE);
        return s.length > 0 ? s : null;
      } finally { wasm._free(out); }
    },

    actorStarted(tStar, pH)  { wasm._apv_actor_started(reg, BigInt(tStar), BigInt(pH)); },
    actorStopped(tStar, pH)  { wasm._apv_actor_stopped(reg, BigInt(tStar), BigInt(pH)); },
    vacatePrefix(tStar, pH)  { wasm._apv_vacate_prefix(reg, BigInt(tStar), BigInt(pH)); },

    registerChangepointParallel(tStar, rHashes, ref, cid) {
      const rp = toPtr(regionHashesToBuffer(rHashes));
      const sp = strPtr(cid);
      try   { return wasm._apv_register_changepoint_parallel(reg, BigInt(tStar), rp, rHashes.length, BigInt(ref), sp); }
      finally { wasm._free(rp); wasm._free(sp); }
    },

    computeAccessibleParallel(rHashes, logT, curT) {
      const rp  = toPtr(regionHashesToBuffer(rHashes));
      const out = wasm._malloc(OUTPUT_BUFFER_SIZE);
      try {
        const rc = wasm._apv_compute_accessible_parallel(reg, rp, rHashes.length, BigInt(logT), BigInt(curT), out, OUTPUT_BUFFER_SIZE);
        if (rc !== 1) return null;
        const s = wasm.UTF8ToString(out, OUTPUT_BUFFER_SIZE);
        return s.length > 0 ? s : null;
      } finally { wasm._free(rp); wasm._free(out); }
    },

    destroy() { try { wasm._apv_registry_destroy(reg); } catch {} },
  };
}

let engineSingleton = null;
export const engineReady = loadEngine().then(e => { engineSingleton = e; });

export function getEngine() {
  if (!engineSingleton) throw new Error('[ffi/engine] Engine not loaded — await engineReady first.');
  return engineSingleton;
}

export default { getEngine, engineReady };
