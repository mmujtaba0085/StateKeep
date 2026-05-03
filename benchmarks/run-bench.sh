#!/usr/bin/env bash
export PATH=/home/moham/.nvm/versions/node/v22.22.2/bin:/usr/bin:/bin:$PATH
cd /mnt/d/Project/StateKeep-fixed

# Fresh DB
rm -f /tmp/sk-live.db /tmp/sk-live.db-shm /tmp/sk-live.db-wal

# Start server
NODE_ENV=test \
  STATEKEEP_DB_PATH=/tmp/sk-live.db \
  STATEKEEP_ENCRYPTION_KEY=a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456 \
  STATEKEEP_ADMIN_KEY=admin-secret-key \
  STATEKEEP_ENGINE_PATH=src/ffi/libapv-engine.so \
  node --env-file=.env src/api/server.js > /tmp/sk-server.log 2>&1 &
SERVER_PID=$!

# Start migrate-worker with the APV engine. The worker seeds its registry from
# the changepoints table on startup (initWorkerRegistry), so it shares the same
# routing state as the server without requiring a shared in-process registry.
#
# HOT_REGISTRY_SIZE=100 + ACTORS_PER_WORKER=100 = 1 worker thread (not 20).
# DrvFs (/mnt/d/) is 10-100x slower than native Linux for module loading.
# 20 cold threads all loading from DrvFs simultaneously exceeds the 30s pool
# timeout. One thread loads in ~5s and handles all BENCHMARK_ACTOR_COUNT actors.
NODE_ENV=test \
  STATEKEEP_DB_PATH=/tmp/sk-live.db \
  STATEKEEP_ENCRYPTION_KEY=a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456 \
  STATEKEEP_ADMIN_KEY=admin-secret-key \
  STATEKEEP_ENGINE_PATH=src/ffi/libapv-engine.so \
  HOT_REGISTRY_SIZE=100 \
  ACTORS_PER_WORKER=100 \
  node src/workers/migrate-worker.js > /tmp/sk-worker.log 2>&1 &
WORKER_PID=$!

echo "Server PID: $SERVER_PID  Worker PID: $WORKER_PID"

# Wait up to 20s for server to come up
READY=0
for i in $(seq 1 20); do
  sleep 1
  if curl -sf http://127.0.0.1:3001/v1/health > /dev/null 2>&1; then
    READY=1
    break
  fi
done

if [ $READY -eq 0 ]; then
  echo "Server failed to start after 20s:"
  cat /tmp/sk-server.log
  kill $SERVER_PID $WORKER_PID 2>/dev/null
  exit 1
fi
echo "Server up. Engine: $(curl -sf http://127.0.0.1:3001/v1/health | grep -o '"engine":"[^"]*"')"
echo ""

# Run benchmarks
cd /mnt/d/Project/StateKeep-fixed/benchmarks
node run-all.js
STATUS=$?

# Cleanup
kill $SERVER_PID $WORKER_PID 2>/dev/null
echo ""
echo "Exit: $STATUS"
exit $STATUS
