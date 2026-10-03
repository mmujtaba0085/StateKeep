#!/usr/bin/env bash
# Machine-check the APV formalization.
# Toolchain: Lean (version 4.12.0, x86_64-unknown-linux-gnu, commit dc2533473114, Release)
# Lean 4 core only -- no Mathlib, no Lake, no elan.
#
# Lean binary lookup order:
#   1. $LEAN
#   2. `lean` on PATH, if it is version 4.12.0
#   3. ./.toolchain/lean-4.12.0-linux/bin/lean    (downloaded from the GitHub release if absent)
set -euo pipefail
cd "$(dirname "$0")"
VER=4.12.0

if [[ -n "${LEAN:-}" ]]; then :
elif command -v lean >/dev/null && lean --version | grep -q "version $VER,"; then LEAN=lean
else
  LEAN=./.toolchain/lean-$VER-linux/bin/lean
  if [[ ! -x $LEAN ]]; then
    mkdir -p .toolchain
    curl -L -sS -o .toolchain/lean.tar.zst \
      "https://github.com/leanprover/lean4/releases/download/v$VER/lean-$VER-linux.tar.zst"
    python3 -c "
import zstandard, tarfile
with open('.toolchain/lean.tar.zst','rb') as f:
    tarfile.open(fileobj=zstandard.ZstdDecompressor().stream_reader(f), mode='r|').extractall('.toolchain')
"
    rm .toolchain/lean.tar.zst
  fi
fi

"$LEAN" --version
"$LEAN" --version | grep -q "version $VER," || { echo "expected Lean $VER"; exit 1; }

# forbidden constructs (comments included, so any mention fails loudly)
if grep -nwE 'sorry|admit|native_decide' APV.lean; then echo "FAIL: forbidden token"; exit 1; fi
if grep -nE '^\s*axiom\s' APV.lean; then echo "FAIL: axiom declaration"; exit 1; fi

OUT=$("$LEAN" APV.lean 2>&1) || { echo "$OUT"; echo "FAIL: lean exited non-zero"; exit 1; }
echo "$OUT"
if echo "$OUT" | grep -qE 'error|declaration uses .sorry.'; then echo "FAIL: errors"; exit 1; fi
# every '#print axioms' line may mention only Lean's standard axioms
if echo "$OUT" | grep 'depends on axioms' | sed 's/.*\[//; s/\]//' | tr ',' '\n' | tr -d ' ' \
   | grep -vE '^(propext|Classical\.choice|Quot\.sound)$' | grep -q .; then
  echo "FAIL: non-standard axiom"; exit 1
fi
echo "OK: APV.lean checked, 0 errors, no sorry/admit/native_decide, standard axioms only"
