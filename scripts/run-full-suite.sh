#!/usr/bin/env bash
# Runs statechart/legacy tests + all E2E Playwright specs
set -euo pipefail
cd /mnt/d/Project/StateKeep-fixed

NODE=$HOME/.nvm/versions/node/v22.22.2/bin/node
DB=/tmp/sk-full-$(date +%s).db
KEY=$(openssl rand -hex 32)

export STATEKEEP_DB_PATH=$DB
export STATEKEEP_ENCRYPTION_KEY=$KEY
export STATEKEEP_ADMIN_KEY=test-admin-key
export NODE_ENV=test
export PORT=3099
export STATEKEEP_API_KEY=__test_key_do_not_use_in_production__

echo "====== Statechart + Legacy ======"
bash scripts/run-all-tests.sh

echo ""
echo "====== E2E (Playwright) ======"

# Kill any server on 3001
pkill -f 'node src/api/server.js' 2>/dev/null || true
sleep 0.3

# E2E tests use port 3001
export PORT=3001

$NODE src/api/server.js >/tmp/sk-full-e2e-srv.log 2>&1 &
SRV=$!

for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:3001/v1/health >/dev/null 2>&1 && break
  sleep 0.3
done
echo "E2E server ready (pid $SRV)"

$NODE node_modules/.bin/playwright test --reporter=line 2>&1
E2E_EXIT=$?

kill $SRV 2>/dev/null || true

echo ""
if [ $E2E_EXIT -eq 0 ]; then
  echo "E2E: PASS"
else
  echo "E2E: FAIL (exit $E2E_EXIT)"
fi
