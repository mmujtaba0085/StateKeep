#!/usr/bin/env bash
# scripts/multihost/node.sh — start one StateKeep cluster server (+ its scheduler) on this machine.
#
#   NODE_ID=B DB_URL=postgres://user:pw@db-host:5432/statekeep_mh PUBLIC_URL=http://10.0.0.12:3000 \
#   API_KEY=<same on every machine> ADMIN_KEY=<same on every machine> ENC_KEY=<same 64-hex on every machine> \
#   bash scripts/multihost/node.sh
#
# Optional: CLOCK_OFFSET_MS=300000 CLOCK_RATE=1.25 run this server on a skewed clock
# (test/helpers/skewClock.mjs), in addition to whatever this machine's real clock does.
# Test hooks (deterministic pauses) are enabled in $HOOK_DIR (default /tmp/sk-mh-hooks).
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${NODE_ID:?}" "${DB_URL:?}" "${PUBLIC_URL:?}" "${API_KEY:?}" "${ADMIN_KEY:?}" "${ENC_KEY:?}"
PORT="${PORT:-3000}"
HOOK_DIR="${HOOK_DIR:-/tmp/sk-mh-hooks}"
LOGS="${LOGS:-/tmp/sk-mh-logs}"
mkdir -p "$HOOK_DIR" "$LOGS"

export NODE_ENV=test HOST=0.0.0.0 PORT STATEKEEP_DB_URL="$DB_URL" STATEKEEP_CLUSTER=true \
  STATEKEEP_NODE_ID="$NODE_ID" STATEKEEP_NODE_URL="$PUBLIC_URL" STATEKEEP_ADMIN_KEY="$ADMIN_KEY" \
  STATEKEEP_ENCRYPTION_KEY="$ENC_KEY" STATEKEEP_NODE_TTL_MS="${TTL_MS:-3000}" \
  STATEKEEP_TEST_HOOK_DIR="$HOOK_DIR" SCHEDULER_POLL_INTERVAL=200 STATEKEEP_CLOCK_RESYNC_MS=1000 \
  LOG_DIR="$LOGS" STATEKEEP_DATA_DIR="$LOGS" STATEKEEP_INTERNAL_URL="http://127.0.0.1:$PORT"
export STATEKEEP_API_KEY="$API_KEY"          # it listens on the network: never unauthenticated
if [[ -n "${CLOCK_OFFSET_MS:-}${CLOCK_RATE:-}" ]]; then
  export NODE_OPTIONS="--import=$(pwd)/test/helpers/skewClock.mjs" SK_CLOCK_OFFSET_MS="${CLOCK_OFFSET_MS:-0}" SK_CLOCK_RATE="${CLOCK_RATE:-1}"
fi

node src/api/server.js >>"$LOGS/$NODE_ID.log" 2>&1 & SERVER=$!
node src/workers/scheduler-worker.js >>"$LOGS/$NODE_ID-scheduler.log" 2>&1 & SCHED=$!
trap 'kill $SERVER $SCHED 2>/dev/null' EXIT INT TERM
echo "node $NODE_ID: server pid $SERVER, scheduler pid $SCHED, hooks $HOOK_DIR, logs $LOGS"
wait $SERVER
