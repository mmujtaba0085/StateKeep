#!/usr/bin/env bash
# Run the Lean oracle (APV.lean + Oracle.lean) on stdin. Lean: $LEAN, or `lean` on PATH.
set -euo pipefail
cd "$(dirname "$0")"
LEAN=${LEAN:-lean}
TMP=$(mktemp -d)
grep -v "^#print axioms" APV.lean | cat - Oracle.lean > "$TMP/OracleRun.lean"
"$LEAN" --run "$TMP/OracleRun.lean"
rm -rf "$TMP"
