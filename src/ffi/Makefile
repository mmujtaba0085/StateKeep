CC      = gcc
CFLAGS  = -shared -fPIC -O2 -Wall -Wextra -std=c11 -pthread
TARGET  = libapv-engine-fixed.so
SRC     = apv-engine-fixed.c
HDR     = apv-engine-fixed.h

# WASM build via Emscripten — requires emcc on PATH (https://emscripten.org)
EMCC      = emcc
WASM_OUT  = apv-engine.mjs
WASM_FLAGS = -O2 -std=c11 \
  -sWASM=1 \
  -sWASM_BIGINT=1 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=node \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_apv_registry_create,_apv_registry_destroy,_apv_clock_tick,_apv_register_changepoint,_apv_compute_accessible,_apv_actor_started,_apv_actor_stopped,_apv_vacate_prefix,_apv_fnv1a_init,_apv_fnv1a_update,_apv_fnv1a_final,_apv_register_changepoint_parallel,_apv_compute_accessible_parallel,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=UTF8ToString

.PHONY: all wasm clean

all: $(TARGET)

$(TARGET): $(SRC) $(HDR)
	$(CC) $(CFLAGS) -o $@ $(SRC)

wasm: $(SRC) $(HDR)
	$(EMCC) $(WASM_FLAGS) -o $(WASM_OUT) $(SRC)
	@echo "WASM build complete: $(WASM_OUT) + apv-engine.wasm"

clean:
	rm -f $(TARGET) $(WASM_OUT) apv-engine.wasm
