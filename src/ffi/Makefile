# src/ffi/Makefile
#
# The APV engine is distributed as a pre-built WebAssembly module (apv-engine.mjs, which
# embeds the binary). The C source is proprietary and not included in this repository.
#
# The module is built from apv-engine.c with zig's clang (no Emscripten needed):
#
#   zig cc -target wasm32-wasi -O2 -std=c11 -mexec-model=reactor -s -Wl,--strip-all \
#     -Wl,--export=apv_registry_create -Wl,--export=apv_registry_destroy \
#     -Wl,--export=apv_clock_tick -Wl,--export=apv_clock_now -Wl,--export=apv_clock_advance_to \
#     -Wl,--export=apv_register_changepoint -Wl,--export=apv_compute_accessible \
#     -Wl,--export=apv_register_changepoint_scoped -Wl,--export=apv_compute_accessible_scoped \
#     -Wl,--export=apv_register_changepoint_parallel -Wl,--export=apv_compute_accessible_parallel \
#     -Wl,--export=apv_register_changepoint_parallel_scoped \
#     -Wl,--export=apv_compute_accessible_parallel_scoped \
#     -Wl,--export=apv_compute_accessible_scoped_ex -Wl,--export=apv_compute_accessible_parallel_scoped_ex \
#     -Wl,--export=apv_collect_before_scoped \
#     -Wl,--export=apv_actor_started -Wl,--export=apv_actor_stopped -Wl,--export=apv_vacate_prefix \
#     -Wl,--export=apv_fnv1a_init -Wl,--export=apv_fnv1a_update -Wl,--export=apv_fnv1a_final \
#     -Wl,--export=malloc -Wl,--export=free \
#     -o apv-engine.wasm apv-engine.c
#
# and wrapped into apv-engine.mjs (base64-embedded, same interface as the earlier
# Emscripten build: default export async () => ({ _apv_*, _malloc, _free, HEAPU8,
# UTF8ToString })). engine.js also still accepts an older Emscripten build (without
# scopes or apv_clock_advance_to) and falls back for those functions.

.PHONY: clean
clean:
	rm -f apv-engine.wasm
