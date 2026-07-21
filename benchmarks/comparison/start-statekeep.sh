#!/bin/bash
# Start StateKeep locally for the Tier 3 benchmark.
# Run from WSL: bash benchmarks/comparison/start-statekeep.sh
# The server stays running. Ctrl+C to stop it.

source ~/.nvm/nvm.sh 2>/dev/null
export PATH="/home/$(whoami)/.nvm/versions/node/v22.22.2/bin:/usr/bin:/bin:$PATH"
cd /mnt/d/Project/StateKeep-fixed

pkill -f "node src/api/server.js" 2>/dev/null
sleep 0.5
rm -f /tmp/sk-bench.db /tmp/sk-bench.db-shm /tmp/sk-bench.db-wal

export NODE_ENV=test
export PORT=3001
export STATEKEEP_DB_PATH=/tmp/sk-bench.db
export STATEKEEP_ENCRYPTION_KEY=a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456
export STATEKEEP_ADMIN_KEY=bench-admin-key
export STATEKEEP_API_KEY=sk_bench00_0000000000000000000000000000000000000000
export HOT_REGISTRY_SIZE=500

echo "Starting StateKeep on port 3001..."
node src/api/server.js
