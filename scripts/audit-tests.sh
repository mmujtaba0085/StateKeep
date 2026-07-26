#!/usr/bin/env bash
# scripts/audit-tests.sh
#
# Run every test group and summarise results.
# Execute from WSL at the repo root:
#   bash scripts/audit-tests.sh 2>&1 | tee /tmp/audit-$(date +%s).txt
#
# Each group runs independently. Failures in one group do not stop the rest.

set -uo pipefail

PASS=0
FAIL=0
GROUPS_FAILED=()

run_group() {
  local label="$1"
  local cmd="$2"
  local flag="${3:-}"      # optional env var prefix (e.g. STRESS=1)

  echo ""
  echo "════════════════════════════════════════"
  echo "  $label"
  echo "════════════════════════════════════════"

  local output exit_code
  output=$(eval "${flag:+$flag }$cmd" 2>&1) && exit_code=0 || exit_code=$?

  echo "$output"

  local passed failed
  passed=$(echo "$output" | grep -c '^ok ' 2>/dev/null || true)
  failed=$(echo "$output" | grep -c '^not ok ' 2>/dev/null || true)

  PASS=$((PASS + passed))
  FAIL=$((FAIL + failed))

  if [ $exit_code -ne 0 ] || [ "$failed" -gt 0 ]; then
    GROUPS_FAILED+=("$label (pass=$passed fail=$failed exit=$exit_code)")
  fi

  echo ""
  echo "  → pass: $passed  fail: $failed  exit: $exit_code"
}

# ── Test groups ──────────────────────────────────────────────────────────────

run_group "Statechart suite (sc1-sc17 + crypto)" \
  "node --test test/statechart/sc*.js test/crypto.spec.js"

run_group "Hot-path suite" \
  "node --test --test-concurrency=1 test/statechart/hot-path/*.spec.js"

run_group "Unit — level 1" \
  "node --test test/level1/unit.ffi.js test/level1/unit.db.js"

run_group "Integration — level 2" \
  "node --test test/level2/integration.eventflow.js test/level2/integration.concurrency.js"

run_group "Migration — level 3" \
  "node --test test/level3/migration.js"

run_group "Property — level 4" \
  "node --test test/level4/property.js"

run_group "Stress — level 5" \
  "node --test test/level5/stress.js" \
  "STRESS=1"

run_group "Chaos — level 6" \
  "node --test test/level6/chaos.js"

run_group "Edge — level 7" \
  "node --test test/level7/edge.js"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════"
echo "  AUDIT SUMMARY"
echo "════════════════════════════════════════"
echo "  Total pass : $PASS"
echo "  Total fail : $FAIL"
echo ""

if [ ${#GROUPS_FAILED[@]} -gt 0 ]; then
  echo "  Groups with failures:"
  for g in "${GROUPS_FAILED[@]}"; do
    echo "    ✗ $g"
  done
else
  echo "  All groups passed."
fi
echo ""
