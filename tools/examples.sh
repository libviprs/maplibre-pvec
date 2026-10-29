#!/usr/bin/env bash
# Runs the examples in the Playwright container on the docker host and pulls the screenshots back
# into examples/out/. Drive it through /Users/rom/workspace/xdg-pw-lock.sh.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
NASSH=${NASSH:-/Users/rom/workspace/libviprs/tools/nas.sh}
NAS=${NAS:-devshell@192.168.0.100}
NAME=${EX_NAME:-mlp-ex-$(basename "$HERE")}
PW_IMAGE=${PW_IMAGE:-mcr.microsoft.com/playwright:v1.48.2-jammy}
trap '"$NASSH" clean "$NAME" >/dev/null 2>&1 || true' EXIT
"$NASSH" push "$HERE" "$NAME"
set +e
"$NASSH" run "$NAME" "$PW_IMAGE" "mkdir -p /work/examples-out && examples/run-all.sh"
rc=$?
set -e
mkdir -p "$HERE/examples/out"
ssh -o BatchMode=yes -o LogLevel=ERROR "$NAS" "cd /work/nas-work/$NAME/examples-out 2>/dev/null && tar -cf - ." | tar -xf - -C "$HERE/examples/out" || true
exit $rc
