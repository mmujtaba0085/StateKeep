#!/usr/bin/env bash
# scripts/run-statechart-tests.sh
#
# Runs the full statechart test suite (SC1–SC9) in order.
# Requires the API server to be running on PORT 3099.
#
# Usage:
#   ./scripts/run-statechart-tests.sh           — start server automatically
#   SC_SKIP_SERVER=1 ./scripts/run-statechart-tests.sh  — server already running
#
# Exit codes:
#   0 = all tests passed (or only [GAP] tests failed)
#   1 = unexpected failures

set -euo pipefail
cd "$(dirname "$0")/.."

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $*${NC}"; }
fail() { echo -e "${RED}✗ $*${NC}"; }
info() { echo -e "${BLUE}→ $*${NC}"; }
warn() { echo -e "${YELLOW}⚠ $*${NC}"; }

export STATEKEEP_DB_PATH="${STATEKEEP_DB_PATH:-/tmp/sc-test-$(date +%s).db}"
export STATEKEEP_ENCRYPTION_KEY="${STATEKEEP_ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
export NODE_ENV=test
export PORT=3099
export LOG_DIR=/tmp/sc-test-logs
export STATEKEEP_DATA_DIR=/tmp/sc-test-data

mkdir -p "$LOG_DIR" "$STATEKEEP_DATA_DIR"

SERVER_PID=""

# ── Start server if not skipped ───────────────────────────────────────────────
if [[ "${SC_SKIP_SERVER:-0}" != "1" ]]; then
  info "Starting API server..."
  node src/api/server.js >"$LOG_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null; exit 130' INT TERM

  for i in $(seq 1 40); do
    curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break
    sleep 0.3
  done
  ok "Server ready (PID $SERVER_PID)"
fi

PASS=0; FAIL=0

run() {
  local label="$1"
  local file="$2"
  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  info "Running $label"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  if node --test "$file" 2>&1; then
    ok "$label PASSED"
    ((PASS++)) || true
  else
    fail "$label FAILED"
    ((FAIL++)) || true
  fi
}

echo ""
echo -e "${BLUE}══════════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  StateKeep Statechart Test Suite                                 ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════════════${NC}"

run "SC1: Valid Statecharts (all should PASS)"      "test/statechart/sc1.valid.js"
run "SC2: Structural Breakage (expose gaps)"        "test/statechart/sc2.structural.js"
run "SC3: Logically Stuck Machines"                 "test/statechart/sc3.stuck.js"
run "SC4: Migration Scenarios"                      "test/statechart/sc4.migration.js"
run "SC5: Complex Multi-Actor + Many Refinements"   "test/statechart/sc5.complex.js"
run "SC6: GC + Snapshot Worker Correctness"         "test/statechart/sc6.workers.js"
run "SC7: E2E Regression + Example Files"           "test/statechart/sc7.e2e.js"
run "SC8: Confirm-Token + needs_rescue Flow"         "test/statechart/sc8.confirmtoken.js"
run "SC9: Migration Routing (unit)"                  "test/statechart/sc9.unit.js"
run "SC9: Migration Routing (HTTP)"                  "test/statechart/sc9.migration-routing.js"

[[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true

echo ""
echo -e "${BLUE}══════════════════════════════════════════════════════════════════${NC}"
echo -e "  ${GREEN}Passed:  $PASS${NC}  |  ${RED}Failed: $FAIL${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════════════${NC}"

[[ $FAIL -gt 0 ]] && { fail "Statechart tests FAILED ($FAIL)"; exit 1; }
ok "All statechart tests PASSED"; exit 0
