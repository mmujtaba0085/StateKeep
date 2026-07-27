#!/bin/sh
# Start all StateKeep background workers, then bring up the API server.
# Workers restart automatically on crash (via the while loop) at the systemd
# RestartSec equivalent of 10 s, matching the deployment.md service units.

for w in migrate webhook gc snapshot metrics scheduler; do
  (while true; do
    node src/workers/${w}-worker.js
    echo "[start.sh] ${w}-worker exited (code $?), restarting in 10s" >&2
    sleep 10
  done) &
done

exec node src/api/server.js
