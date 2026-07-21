# src/ffi/Makefile
#
# The APV engine is distributed as a pre-built WASM binary (apv-engine.mjs).
# The C source is proprietary and not included in this repository.
#
# If you need to rebuild the WASM binary from source (not publicly available),
# the build command used was:
#
#   emcc -O2 -std=c11 \
#     -sWASM=1 -sWASM_BIGINT=1 -sMODULARIZE=1 -sEXPORT_ES6=1 \
#     -sENVIRONMENT=node -sALLOW_MEMORY_GROWTH=1 \
#     -sEXPORTED_FUNCTIONS=_apv_registry_create,_apv_registry_destroy,\
#       _apv_clock_tick,_apv_register_changepoint,_apv_compute_accessible,\
#       _apv_actor_started,_apv_actor_stopped,_apv_vacate_prefix,\
#       _apv_fnv1a_init,_apv_fnv1a_update,_apv_fnv1a_final,\
#       _apv_register_changepoint_parallel,_apv_compute_accessible_parallel,\
#       _malloc,_free \
#     -sEXPORTED_RUNTIME_METHODS=UTF8ToString \
#     -o apv-engine.mjs apv-engine-fixed.c
#
# The pre-built apv-engine.mjs in this directory is the output of that command.

.PHONY: clean
clean:
	rm -f libapv-engine-fixed.so
