#!/usr/bin/env bash
cd /mnt/d/Project/StateKeep-fixed
NODE=$HOME/.nvm/versions/node/v22.22.2/bin/node

DB=/tmp/sk-e2e-sec-$(date +%s).db
KEY=$(openssl rand -hex 32)

export STATEKEEP_DB_PATH=$DB
export STATEKEEP_ENCRYPTION_KEY=$KEY
export STATEKEEP_ADMIN_KEY=test-admin-key
export NODE_ENV=test
export PORT=3001
export STATEKEEP_API_KEY=sk_ab12cd34_0000000000000000000000000000000000000000

pkill -f 'node src/api/server.js' 2>/dev/null || true
sleep 0.3

$NODE src/api/server.js >/tmp/sk-e2e-srv.log 2>&1 &
SRV=$!

for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:3001/v1/health >/dev/null 2>&1 && break
  sleep 0.3
done
echo "Server ready"

$NODE node_modules/.bin/playwright test test/e2e/security.spec.js --reporter=line 2>&1

kill $SRV 2>/dev/null
