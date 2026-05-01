#!/usr/bin/env bash
# scripts/run-tests.sh
#
# Unified test runner for StateKeep.
# Runs all test levels in order: unit → integration → property → [stress] → [chaos] → edge
#
# Usage:
#   ./scripts/run-tests.sh                  — Levels 1-4, 6, 7 (fast suite)
#   STRESS=1 ./scripts/run-tests.sh         — Include Level 5 stress tests
#   C_TESTS=1 ./scripts/run-tests.sh        — Include C FFI tests (requires make -C test/c)
#   MOCK_ENGINE=1 ./scripts/run-tests.sh    — Load mock .so instead of fallback
#   REAL_ENGINE=1 ./scripts/run-tests.sh    — Use real engine (STATEKEEP_ENGINE_PATH must be set)
#
# Exit codes:
#   0 = all tests passed
#   1 = one or more test failures
#   2 = server failed to start

set -euo pipefail
cd "$(dirname "$0")/.."

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $*${NC}"; }
fail() { echo -e "${RED}✗ $*${NC}"; }
info() { echo -e "${BLUE}→ $*${NC}"; }
warn() { echo -e "${YELLOW}⚠ $*${NC}"; }

# ── Environment ───────────────────────────────────────────────────────────────
export STATEKEEP_DB_PATH="${STATEKEEP_DB_PATH:-/tmp/statekeep-test-$(date +%s).db}"
export STATEKEEP_ENCRYPTION_KEY="${STATEKEEP_ENCRYPTION_KEY:-$(python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || openssl rand -hex 32)}"
export STATEKEEP_ADMIN_KEY="${STATEKEEP_ADMIN_KEY:-$(openssl rand -hex 32)}"
export NODE_ENV=test
export PORT=3099
export LOG_DIR=/tmp/statekeep-test-logs
export STATEKEEP_DATA_DIR=/tmp/statekeep-test-data

mkdir -p "$LOG_DIR" "$STATEKEEP_DATA_DIR"

# ── Mock engine ───────────────────────────────────────────────────────────────
if [[ "${MOCK_ENGINE:-0}" == "1" ]]; then
  if [[ ! -f "mock/libapv-mock.so" ]]; then
    info "Building mock engine..."
    make -C mock || { warn "Mock build failed — falling back to JS fallback mode"; }
  fi
  if [[ -f "mock/libapv-mock.so" ]]; then
    export STATEKEEP_ENGINE_PATH="$(pwd)/mock/libapv-mock.so"
    info "Using mock engine: $STATEKEEP_ENGINE_PATH"
  fi
elif [[ "${REAL_ENGINE:-0}" == "1" ]]; then
  if [[ -z "${STATEKEEP_ENGINE_PATH:-}" ]]; then
    fail "REAL_ENGINE=1 requires STATEKEEP_ENGINE_PATH to be set"
    exit 1
  fi
  info "Using real engine: $STATEKEEP_ENGINE_PATH"
else
  info "Running in JS fallback mode (no engine .so)"
fi

# ── Start server ──────────────────────────────────────────────────────────────
SERVER_PID=""

start_server() {
  info "Starting API server on port $PORT..."
  node src/api/server.js >"$LOG_DIR/server.log" 2>&1 &
  SERVER_PID=$!

  # Wait for health endpoint
  for i in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1; then
      ok "Server started (PID $SERVER_PID)"
      return 0
    fi
    sleep 0.25
  done

  fail "Server failed to start within 10s — check $LOG_DIR/server.log"
  kill "$SERVER_PID" 2>/dev/null || true
  return 2
}

stop_server() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

trap 'stop_server; echo -e "\n${YELLOW}Interrupted${NC}"; exit 130' INT TERM

# ── Test runner ───────────────────────────────────────────────────────────────
PASS=0; FAIL=0; SKIP=0

run_test_file() {
  local label="$1"
  local file="$2"
  local skip_reason="${3:-}"

  if [[ -n "$skip_reason" ]]; then
    warn "SKIP $label — $skip_reason"
    ((SKIP++)) || true
    return 0
  fi

  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  info "Running $label"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

  if node --test "$file" 2>&1; then
    ok "$label PASSED"
    ((PASS++)) || true
  else
    fail "$label FAILED"
    ((FAIL++)) || true
  fi
}

# ── Level 1: Unit (no server needed) ─────────────────────────────────────────
echo ""
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  LEVEL 1: Unit Tests (FFI + DB)                  ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"

run_test_file "L1: FFI Loader & Hashing"   "test/level1/unit.ffi.js"
run_test_file "L1: SQLite Persistence"     "test/level1/unit.db.js"

# ── Level 4: Property (no server needed) ─────────────────────────────────────
echo ""
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  LEVEL 4: Property-Based / Invariants            ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"

run_test_file "L4: Properties"             "test/level4/property.js"

# ── Start server for integration + higher tests ───────────────────────────────
start_server || { fail "Server startup failed — skipping integration tests"; exit 2; }

# ── Level 2: Integration ──────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  LEVEL 2: Integration Tests                      ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"

run_test_file "L2: Event Flow"             "test/level2/integration.eventflow.js"
run_test_file "L2: Concurrency + Auth"     "test/level2/integration.concurrency.js"

# ── Level 3: Migration ────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  LEVEL 3: Migration Tests                        ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"

run_test_file "L3: Migration"              "test/level3/migration.js"

# ── Level 5: Stress (optional) ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  LEVEL 5: Stress Tests                           ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"

if [[ "${STRESS:-0}" == "1" ]]; then
  STRESS=1 run_test_file "L5: Stress"      "test/level5/stress.js"
else
  warn "SKIP L5: Stress — run with STRESS=1 to enable"
  ((SKIP++)) || true
fi

# ── Level 6: Chaos ────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  LEVEL 6: Chaos & Failure Tests                  ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"

run_test_file "L6: Chaos"                  "test/level6/chaos.js"

# ── Level 7: Edge Cases ───────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  LEVEL 7: Edge Cases & Compatibility             ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"

run_test_file "L7: Edge Cases"             "test/level7/edge.js"

# ── C FFI Tests (optional) ────────────────────────────────────────────────────
if [[ "${C_TESTS:-0}" == "1" ]]; then
  echo ""
  echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}  C FFI Direct Tests                              ${NC}"
  echo -e "${BLUE}══════════════════════════════════════════════════${NC}"

  if make -C test/c test 2>&1; then
    ok "C FFI Tests PASSED"
    ((PASS++)) || true
  else
    fail "C FFI Tests FAILED"
    ((FAIL++)) || true
  fi
fi


# ── Statechart Tests (SC1–SC7) ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  STATECHART TESTS (SC1–SC7)                      ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"

run_test_file "SC1: Valid Statecharts"           "test/statechart/sc1.valid.js"
run_test_file "SC2: Structural Breakage"         "test/statechart/sc2.structural.js"
run_test_file "SC3: Logically Stuck Machines"    "test/statechart/sc3.stuck.js"
run_test_file "SC4: Migration Scenarios"         "test/statechart/sc4.migration.js"
run_test_file "SC5: Complex Multi-Actor"         "test/statechart/sc5.complex.js"
run_test_file "SC6: GC + Snapshot Workers"       "test/statechart/sc6.workers.js"
run_test_file "SC7: E2E Regression"              "test/statechart/sc7.e2e.js"
run_test_file "SC8: Confirm-Token + needs_rescue"  "test/statechart/sc8.confirmtoken.js"

# ── Existing tests (backward compat) ─────────────────────────────────────────
echo ""
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Legacy Tests (original test/ files)             ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"

LEGACY_FILES=(
  test/test_spawn_actor.js
  test/test_send_event.js
  test/test_actor_termination.js
  test/test_concurrent_events.js
  test/test_migration_orchestration.js
)

for f in "${LEGACY_FILES[@]}"; do
  [[ -f "$f" ]] && run_test_file "Legacy: $(basename "$f" .js)" "$f"
done

# ── Stop server ───────────────────────────────────────────────────────────────
stop_server

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  SUMMARY                                         ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
echo -e "  ${GREEN}Passed:  $PASS${NC}"
echo -e "  ${RED}Failed:  $FAIL${NC}"
echo -e "  ${YELLOW}Skipped: $SKIP${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"

if [[ $FAIL -gt 0 ]]; then
  fail "Test suite FAILED ($FAIL failures)"
  exit 1
else
  ok "All tests PASSED"
  exit 0
fi
