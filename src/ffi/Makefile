# src/ffi/Makefile
#
# The APV engine ships pre-built as apv-engine.mjs (a small loader with the WebAssembly
# binary embedded). Its C source is closed and is not part of this repository, so there
# is nothing to build here; `make check` only confirms the module loads and exports the
# functions StateKeep uses.
#
# Provenance: the header of apv-engine.mjs records the zig version (0.13.0, pinned), the
# compiler flags, and the size and SHA-256 of the embedded WebAssembly. The build is
# reproducible: the engine package's `make verify REPO=<this repo>` rebuilds the module
# from source and checks it is byte-for-byte the one committed here.
#
# Exports used by src/ffi/engine.js:
#   apv_registry_create apv_registry_destroy apv_clock_tick apv_clock_now apv_clock_advance_to
#   apv_register_changepoint[_scoped] apv_compute_accessible[_scoped] apv_compute_accessible_scoped_ex
#   apv_register_changepoint_parallel[_scoped] apv_compute_accessible_parallel[_scoped]
#   apv_compute_accessible_parallel_scoped_ex apv_collect_before_scoped
#   apv_fnv1a_init apv_fnv1a_update apv_fnv1a_final malloc free

.PHONY: check
check:
	node -e "import('./apv-engine.mjs').then(async (m) => { const w = await m.default(); \
	  const need = ['_apv_registry_create','_apv_compute_accessible_scoped_ex','_apv_compute_accessible_parallel_scoped_ex','_apv_collect_before_scoped','_apv_clock_advance_to']; \
	  const miss = need.filter((n) => typeof w[n] !== 'function'); \
	  if (miss.length) { console.error('missing exports:', miss.join(' ')); process.exit(1); } \
	  console.log('apv-engine.mjs OK'); })"
