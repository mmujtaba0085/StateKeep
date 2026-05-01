#!/usr/bin/env bash
NODE=$HOME/.nvm/versions/node/v22.22.2/bin/node
DB=/tmp/sk-sc3-$(date +%s).db
KEY=$(openssl rand -hex 32)
ADMIN_KEY=$(openssl rand -hex 32)
cd /mnt/d/Project/StateKeep-fixed

pkill -f 'node src/api/server.js' 2>/dev/null || true
sleep 0.3

NODE_ENV=test STATEKEEP_DB_PATH=$DB STATEKEEP_ENCRYPTION_KEY=$KEY STATEKEEP_ADMIN_KEY=$ADMIN_KEY PORT=3099 $NODE src/api/server.js >/tmp/sk-srv.log 2>&1 &
SRV=$!

for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:3099/v1/health >/dev/null 2>&1 && break
  sleep 0.3
done
echo "server ready"

NODE_ENV=test STATEKEEP_DB_PATH=$DB STATEKEEP_ENCRYPTION_KEY=$KEY STATEKEEP_ADMIN_KEY=$ADMIN_KEY PORT=3099 \
  $NODE --test test/statechart/sc3.stuck.js 2>&1 > /tmp/sc3-results.txt

echo "sc3 done, server check:"
kill -0 $SRV 2>/dev/null && echo "ALIVE" || echo "DIED"

echo "=== SC3 Summary ==="
grep -E '(# (tests|pass|fail)|not ok)' /tmp/sc3-results.txt || true

kill $SRV 2>/dev/null
