#!/usr/bin/env bash
cd /mnt/d/Project/StateKeep-fixed
NODE=$HOME/.nvm/versions/node/v22.22.2/bin/node

DB=/tmp/sk-sc7-$(date +%s).db
KEY=$(openssl rand -hex 32)

export STATEKEEP_DB_PATH=$DB
export STATEKEEP_ENCRYPTION_KEY=$KEY
export STATEKEEP_ADMIN_KEY=test-admin-key
export NODE_ENV=test
export PORT=3099

pkill -f 'node src/api/server.js' 2>/dev/null || true
sleep 0.3

$NODE src/api/server.js >/tmp/sk-sc7-srv.log 2>&1 &
SRV=$!

for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:3099/v1/health >/dev/null 2>&1 && break
  sleep 0.3
done
echo "Server ready"

$NODE --test test/statechart/sc7.e2e.js 2>&1 | grep -E '# |not ok|ok [0-9]' | head -120

kill $SRV 2>/dev/null
