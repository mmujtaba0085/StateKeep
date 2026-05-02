# test/c/Makefile
#
# Builds the C FFI direct test binary.
# Requires the mock .so to be built first: make -C ../../mock
#
# Usage:
#   make              — build test binary
#   make test         — build + run against mock
#   make test-real    — run against real engine (STATEKEEP_ENGINE_PATH must be set)
#   make clean

CC      = gcc
CFLAGS  = -Wall -Wextra -std=c11 -g -O0 -pthread
LDFLAGS = -ldl -pthread

MOCK_DIR  = ../../mock
MOCK_LIB  = $(MOCK_DIR)/libapv-mock.so
REAL_LIB  ?= /opt/statekeep/lib/libapv-engine.so

TARGET = test_ffi_direct

.PHONY: all test test-real clean mock

all: $(TARGET)

$(TARGET): test_ffi_direct.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

mock:
	$(MAKE) -C $(MOCK_DIR)

test: mock $(TARGET)
	@echo "Running C FFI tests against mock engine..."
	LD_LIBRARY_PATH=$(MOCK_DIR) ./$(TARGET) $(MOCK_LIB)

test-real: $(TARGET)
	@if [ ! -f "$(REAL_LIB)" ] && [ -z "$(STATEKEEP_ENGINE_PATH)" ]; then \
		echo "ERROR: Real engine not found. Set STATEKEEP_ENGINE_PATH or place it at $(REAL_LIB)"; \
		exit 1; \
	fi
	@LIB=$${STATEKEEP_ENGINE_PATH:-$(REAL_LIB)}; \
	echo "Running C FFI tests against real engine: $$LIB"; \
	./$(TARGET) $$LIB

clean:
	rm -f $(TARGET) *.o
