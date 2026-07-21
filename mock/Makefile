# mock/Makefile
#
# The APV mock (libapv-mock.so) was used during early development with the
# koffi FFI approach. The WASM engine (src/ffi/apv-engine.mjs) supersedes it.
#
# The C source (libapv-mock.c) is proprietary and not included in this repo.
# This Makefile is retained as a reference for the build command that was used.
#
# Build command (requires GCC, source file not available publicly):
#   gcc -shared -fPIC -O2 -Wall -Wextra -std=c11 -o libapv-mock.so libapv-mock.c

.PHONY: clean
clean:
	rm -f libapv-mock.so
