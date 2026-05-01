#!/usr/bin/env bash
NODE=$HOME/.nvm/versions/node/v22.22.2/bin/node
DB=/tmp/sk-l6-$(date +%s).db
KEY=$(openssl rand -hex 32)
ADMIN_KEY=$(openssl rand -hex 32)
cd /mnt/d/Project/StateKeep-fixed

export STATEKEEP_DB_PATH=$DB STATEKEEP_ENCRYPTION_KEY=$KEY STATEKEEP_ADMIN_KEY=$ADMIN_KEY NODE_ENV=test PORT=3099

pkill -f 'node src/api/server.js' 2>/dev/null || true
sleep 0.3
$NODE src/api/server.js >/tmp/sk-l6-srv.log 2>&1 &
SRV=$!
for i in $(seq 1 40); do curl -sf http://127.0.0.1:3099/v1/health >/dev/null 2>&1 && break; sleep 0.3; done
echo "server up"

$NODE --test test/level6/chaos.js 2>&1
echo "=== done ==="
kill $SRV 2>/dev/null || true
