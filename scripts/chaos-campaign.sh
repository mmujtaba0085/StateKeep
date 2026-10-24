#!/usr/bin/env bash
# scripts/chaos-campaign.sh — the full workflow fault-injection campaign:
# SQLite, PostgreSQL and a 2-server PostgreSQL cluster, normal and hard intensity,
# plus one long PostgreSQL run. Summary: benchmarks/chaos/summary.json.
#
#   PG_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres bash scripts/chaos-campaign.sh
#
# Each Postgres run gets its own fresh, empty database (wfc_<run>). Takes about an hour.
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=${OUT:-benchmarks/chaos/runs}
PG_ADMIN_URL=${PG_ADMIN_URL:-postgresql://postgres:postgres@127.0.0.1:5432/postgres}
mkdir -p "$OUT"

#   name      seed rounds per-round backend   intensity
RUNS="f-sq-n    61   10     30       sqlite   normal
f-sq-h    62   10     30       sqlite   hard
f-pg-n    63   10     30       postgres normal
f-pg-h    64   10     30       postgres hard
f-cl-n    65   10     30       cluster  normal
f-cl-h    66   10     30       cluster  hard
f-pg-big  67   20     40       postgres hard"

while read -r name seed rounds per backend intensity; do
  dbarg=()
  if [[ $backend != sqlite ]]; then
    db="wfc_${name//-/_}"
    psql "$PG_ADMIN_URL" -q -c "drop database if exists $db with (force)" -c "create database $db"
    dbarg=(--db "${PG_ADMIN_URL%/*}/$db")
  fi
  echo "── $name ($backend, $intensity)"
  node test/chaos/workflow/simulate.mjs --seed "$seed" --rounds "$rounds" --per-round "$per" \
    --backend "$backend" --intensity "$intensity" "${dbarg[@]}" --out "$OUT/$name.json" > "$OUT/$name.log" 2>&1
  echo "   exit $?"
done <<< "$RUNS"

node scripts/chaos-summary.mjs "$OUT"/f-*.json --json benchmarks/chaos/summary.json
