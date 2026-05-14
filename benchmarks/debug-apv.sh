#!/usr/bin/env bash
export PATH=/home/moham/.nvm/versions/node/v22.22.2/bin:/usr/bin:/bin:$PATH
cd /mnt/d/Project/StateKeep-fixed
rm -f /tmp/sk-live.db /tmp/sk-live.db-shm /tmp/sk-live.db-wal

NODE_ENV=test STATEKEEP_DB_PATH=/tmp/sk-live.db \
  STATEKEEP_ENCRYPTION_KEY=a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456 \
  STATEKEEP_ADMIN_KEY=admin-secret-key \
  STATEKEEP_ENGINE_PATH=src/ffi/libapv-engine.so \
  node --env-file=.env src/api/server.js > /tmp/sk-server.log 2>&1 &
SERVER_PID=$!

NODE_ENV=test STATEKEEP_DB_PATH=/tmp/sk-live.db \
  STATEKEEP_ENCRYPTION_KEY=a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456 \
  STATEKEEP_ADMIN_KEY=admin-secret-key \
  STATEKEEP_ENGINE_PATH=src/ffi/libapv-engine.so \
  HOT_REGISTRY_SIZE=100 ACTORS_PER_WORKER=100 \
  node src/workers/migrate-worker.js > /tmp/sk-worker.log 2>&1 &
WORKER_PID=$!

for i in $(seq 1 15); do
  sleep 1
  curl -sf http://127.0.0.1:3001/v1/health > /dev/null 2>&1 && break
done

echo "=== Server up. Running approach 1 ==="
cd /mnt/d/Project/StateKeep-fixed/benchmarks
node run-all.js --only 1 2>&1
echo ""
echo "=== Worker log ==="
cat /tmp/sk-worker.log

kill $SERVER_PID $WORKER_PID 2>/dev/null
