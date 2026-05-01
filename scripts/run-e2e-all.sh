#!/usr/bin/env bash
set -euo pipefail
cd /mnt/d/Project/StateKeep-fixed
NODE=$HOME/.nvm/versions/node/v22.22.2/bin/node
# Use the same DB and key that playwright.config.js / globalSetup.js expect
# so the seeded API key is visible to the already-running server.
rm -f statekeep-test.db statekeep-test.db-wal statekeep-test.db-shm
export STATEKEEP_DB_PATH=statekeep-test.db
export STATEKEEP_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
export STATEKEEP_ADMIN_KEY=test-admin-key
export NODE_ENV=test
export PORT=3001
export STATEKEEP_API_KEY=sk_ab12cd34_0000000000000000000000000000000000000000
export STATEKEEP_DATA_DIR=/tmp/sk-test-data

pkill -f 'node src/api/server.js' 2>/dev/null || true
sleep 0.3

$NODE src/api/server.js >/tmp/sk-e2e-all.log 2>&1 &
SRV=$!

for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:3001/v1/health >/dev/null 2>&1 && break
  sleep 0.3
done
echo "Server ready (pid $SRV)"

$NODE node_modules/.bin/playwright test --reporter=line 2>&1
EXIT=$?

kill $SRV 2>/dev/null || true
echo "Exit: $EXIT"
exit $EXIT
