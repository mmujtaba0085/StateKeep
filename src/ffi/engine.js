/**
 * src/ffi/engine.js
 *
 * Loads libapv-engine.so (or a mock) via koffi at startup.
 * Exports a unified `engine` object matching the same interface as fallback.js.
 *
 * If the library is absent or fails to load, re-exports fallback.js transparently.
 *
 * Library path resolution order:
 *   1. STATEKEEP_ENGINE_PATH environment variable
 *   2. /opt/statekeep/lib/libapv-engine.so
 */

import { existsSync } from 'fs';
import fallback from './fallback.js';

const ENGINE_PATHS = [
  process.env.STATEKEEP_ENGINE_PATH,
  'libapv-engine.so',
].filter(Boolean);

const OUTPUT_BUFFER_SIZE = 512;  // max definition ID length + safety margin

async function tryLoad(libPath) {
  if (!libPath || !existsSync(libPath)) return null;

  let koffi;
  try {
    // koffi is an optional peer dep — if missing we fall back silently
    const mod = await import('koffi').catch(() => null);
    if (!mod) return null;
    koffi = mod.default ?? mod;
  } catch {
    return null;
  }

  try {
    const lib = koffi.load(libPath);

    // ── Opaque registry pointer type ──────────────────────────────────────
    const apv_registry_t = koffi.opaque('apv_registry_t');
    const RegPtr         = koffi.pointer(apv_registry_t);

    // ── Function bindings ──────────────────────────────────────────────────
    const _create    = lib.func('apv_registry_create',    RegPtr,   []);
    const _destroy   = lib.func('apv_registry_destroy',   'void',   [RegPtr]);
    const _tick      = lib.func('apv_clock_tick',         'uint64', [RegPtr]);

    const _register  = lib.func('apv_register_changepoint', 'int', [
      RegPtr, 'uint64', 'uint64', 'uint64', 'str'
    ]);

    const _compute   = lib.func('apv_compute_accessible', 'int', [
      RegPtr, 'uint64', 'uint64', 'uint64', 'uint8 *', 'size_t'
    ]);

    const _started   = lib.func('apv_actor_started',  'void', [RegPtr, 'uint64', 'uint64']);
    const _stopped   = lib.func('apv_actor_stopped',  'void', [RegPtr, 'uint64', 'uint64']);
    const _vacate    = lib.func('apv_vacate_prefix',  'void', [RegPtr, 'uint64', 'uint64']);

    const _fnvInit   = lib.func('apv_fnv1a_init',   'uint64', []);
    const _fnvUpdate = lib.func('apv_fnv1a_update', 'uint64', ['uint64', 'uint8 *', 'size_t']);
    const _fnvFinal  = lib.func('apv_fnv1a_final',  'uint64', ['uint64']);

    // ── Create global registry ────────────────────────────────────────────
    const reg = _create();
    if (!reg) {
      console.error('[ffi/engine] apv_registry_create() returned null — falling back');
      return null;
    }

    console.log(`[ffi/engine] Loaded real APV engine from: ${libPath}`);

    return {
      available: true,

      clockTick() {
        return BigInt(_tick(reg));
      },

      registerChangepoint(tStar, prefixHash, refinement, childDefId) {
        return _register(reg, BigInt(tStar), BigInt(prefixHash), BigInt(refinement), childDefId);
      },

      computeAccessible(currentPrefixHash, actorLogicalTime, currentTime) {
        const outBuf = Buffer.alloc(OUTPUT_BUFFER_SIZE, 0);
        const rc = _compute(
          reg,
          BigInt(currentPrefixHash),
          BigInt(actorLogicalTime),
          BigInt(currentTime),
          outBuf,
          OUTPUT_BUFFER_SIZE
        );
        if (rc === 0) return null;  // 0 = no accessible target; non-zero = found target in buffer
        const targetId = outBuf.toString('utf8').replace(/\0/g, '').trim();
        return targetId.length > 0 ? targetId : null;
      },

      actorStarted(tStar, prefixHash) {
        _started(reg, BigInt(tStar), BigInt(prefixHash));
      },

      actorStopped(tStar, prefixHash) {
        _stopped(reg, BigInt(tStar), BigInt(prefixHash));
      },

      vacatePrefix(tStar, prefixHash) {
        _vacate(reg, BigInt(tStar), BigInt(prefixHash));
      },

      fnv1aInit() {
        return BigInt(_fnvInit());
      },

      fnv1aUpdate(hash, data) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        return BigInt(_fnvUpdate(BigInt(hash), buf, buf.length));
      },

      fnv1aFinal(hash) {
        return BigInt(_fnvFinal(BigInt(hash)));
      },

      destroy() {
        try { _destroy(reg); } catch {}
      },
    };
  } catch (err) {
    console.error(`[ffi/engine] Failed to load ${libPath}: ${err.message}`);
    return null;
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────
// koffi.load is synchronous; we need top-level await inside an async IIFE.

let engineSingleton = null;

async function loadEngine() {
  for (const p of ENGINE_PATHS) {
    const e = await tryLoad(p);
    if (e) { engineSingleton = e; return; }
  }
  console.warn('[ffi/engine] APV engine not available — no-migration fallback mode active.');
  engineSingleton = fallback;
}

// Ensure loaded before first use. The API server awaits this in server.js.
export const engineReady = loadEngine();

export function getEngine() {
  return engineSingleton ?? fallback;
}

export default { getEngine, engineReady };
