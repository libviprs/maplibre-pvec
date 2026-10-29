#!/usr/bin/env bash
# Local gate (Actions is disabled). Nothing runs on this Mac: the tree is
# pushed to the docker host and every command runs in a throw-away container.
#
#   tools/gate.sh            typecheck + unit tests
#   tools/gate.sh e2e        also build the e2e image-less run (playwright image)
#   tools/gate.sh lock       refresh package-lock.json from the container
#
# The e2e step must be driven through /Users/rom/workspace/xdg-pw-lock.sh
# by the caller: xdg-pw-lock.sh tools/gate.sh e2e
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
NASSH=${NASSH:-/Users/rom/workspace/libviprs/tools/nas.sh}
NAME=${GATE_NAME:-mlp-$(basename "$HERE")}
NODE_IMAGE=${NODE_IMAGE:-node:22-bookworm-slim}
PW_IMAGE=${PW_IMAGE:-mcr.microsoft.com/playwright:v1.48.2-jammy}

cleanup() { "$NASSH" clean "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"$NASSH" push "$HERE" "$NAME"

install='if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi'

case ${1:-unit} in
  unit)
    "$NASSH" run "$NAME" "$NODE_IMAGE" "$install && npm run typecheck && npm test"
    ;;
  e2e)
    "$NASSH" run "$NAME" "$PW_IMAGE" "$install && npm run typecheck && npm test && npm run test:e2e"
    ;;
  lock)
    "$NASSH" run "$NAME" "$NODE_IMAGE" "npm install --package-lock-only --no-audit --no-fund"
    ssh -o BatchMode=yes -o LogLevel=ERROR "${NAS:-devshell@192.168.0.100}" "cat /work/nas-work/$NAME/package-lock.json" > "$HERE/package-lock.json"
    ;;
  *) sed -n '2,/^set -euo/p' "$0" >&2; exit 2 ;;
esac
