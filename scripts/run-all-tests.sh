#!/usr/bin/env bash
# scripts/run-all-tests.sh
# Full test suite runner for StateKeep via WSL.

set -uo pipefail
NODE=$HOME/.nvm/versions/node/v22.22.2/bin/node
DB=/tmp/sk-all-$(date +%s).db
KEY=$(openssl rand -hex 32)
ADMIN_KEY=$(openssl rand -hex 32)
PASS=0; FAIL=0

cd /mnt/d/Project/StateKeep-fixed

export STATEKEEP_DB_PATH=$DB
export STATEKEEP_ENCRYPTION_KEY=$KEY
export STATEKEEP_ADMIN_KEY=$ADMIN_KEY
export NODE_ENV=test
export PORT=3099

pkill -f 'node src/api/server.js' 2>/dev/null || true
sleep 0.3

run_no_server() {
  local label="$1" file="$2"
  echo "--- $label ---"
  local out
  out=$($NODE --test "$file" 2>&1)
  local rc=$?
  echo "$out" | grep -E '# (tests|pass|fail|suites)' || true
  if echo "$out" | grep -q '# fail 0'; then
    PASS=$((PASS+1)); echo "$label: PASS"
  else
    FAIL=$((FAIL+1)); echo "$label: FAIL"
    echo "$out" | grep -E 'not ok|Error' | head -20 || true
  fi
}

run_test() {
  local label="$1" file="$2"
  echo "--- $label ---"
  local out
  out=$($NODE --test "$file" 2>&1)
  local rc=$?
  echo "$out" | grep -E '# (tests|pass|fail|suites)' || true
  if echo "$out" | grep -q '# fail 0'; then
    PASS=$((PASS+1)); echo "$label: PASS"
  else
    FAIL=$((FAIL+1)); echo "$label: FAIL"
    echo "$out" | grep -E 'not ok|  at ' | head -30 || true
  fi
}

echo "====== L1: Unit (no server) ======"
run_no_server "L1-FFI"  test/level1/unit.ffi.js
run_no_server "L1-DB"   test/level1/unit.db.js

echo "====== L4: Property (no server) ======"
run_no_server "L4"      test/level4/property.js

echo "====== Starting server ======"
$NODE src/api/server.js >/tmp/sk-all-srv.log 2>&1 &
SRV=$!
for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:3099/v1/health >/dev/null 2>&1 && break
  sleep 0.3
done
echo "Server ready (PID $SRV)"

echo "====== L2: Integration ======"
run_test "L2-EventFlow"    test/level2/integration.eventflow.js
run_test "L2-Concurrency"  test/level2/integration.concurrency.js

echo "====== L3: Migration ======"
run_test "L3-Migration"    test/level3/migration.js

echo "====== L6: Chaos ======"
run_test "L6-Chaos"        test/level6/chaos.js

echo "====== L7: Edge ======"
run_test "L7-Edge"         test/level7/edge.js

echo "====== SC1-SC8 ======"
run_test "SC1"  test/statechart/sc1.valid.js
run_test "SC2"  test/statechart/sc2.structural.js
run_test "SC3"  test/statechart/sc3.stuck.js
run_test "SC4"  test/statechart/sc4.migration.js
run_test "SC5"  test/statechart/sc5.complex.js
run_test "SC6"  test/statechart/sc6.workers.js
run_test "SC7"  test/statechart/sc7.e2e.js
run_test "SC8"  test/statechart/sc8.confirmtoken.js
run_test "SC9"  test/statechart/sc9.migration-routing.js

echo "====== Legacy ======"
for f in test/test_spawn_actor.js test/test_send_event.js test/test_actor_termination.js test/test_concurrent_events.js test/test_migration_orchestration.js; do
  [[ -f "$f" ]] && run_test "Legacy:$(basename $f)" "$f"
done

echo ""
echo "====== SUMMARY ======"
echo "PASS: $PASS  FAIL: $FAIL"
kill $SRV 2>/dev/null || true

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
