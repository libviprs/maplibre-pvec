#!/usr/bin/env bash
# Runs the benchmark harness in a throw-away Playwright container on the native x86_64 docker
# host (never locally, never under Rosetta), then copies bench/results and bench/corpus back.
#
#   tools/bench.sh build-corpus
#   tools/bench.sh check
#   /Users/rom/workspace/xdg-pw-lock.sh tools/bench.sh run --repeat 5
#
# `run` drives Chromium, so launch it through the Playwright lock.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
NASSH=${NASSH:-/Users/rom/workspace/libviprs/tools/nas.sh}
NAS=${NAS:-devshell@192.168.0.100}
NAME=${BENCH_NAME:-mlp-bench-$(basename "$HERE")}
PW_IMAGE=${PW_IMAGE:-mcr.microsoft.com/playwright:v1.48.2-jammy}
COMMIT=$(git -C "$HERE" rev-parse --short HEAD)

cleanup() { "$NASSH" clean "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"$NASSH" push "$HERE" "$NAME"
args=$(printf '%q ' "$@")
status=0
"$NASSH" run "$NAME" "$PW_IMAGE" "npm ci --no-audit --no-fund >/dev/null && BENCH_NATIVE_X86_64=1 BENCH_COMMIT=$COMMIT node bench/run.mjs $args" || status=$?

# Copy the outputs back through ssh. The container wrote them as root, the group bit lets us read.
ssh -o BatchMode=yes -o LogLevel=ERROR "$NAS" "cd /work/nas-work/$NAME && tar -cf - bench/results bench/corpus/corpus.json 2>/dev/null" | tar -xf - -C "$HERE"
exit $status
