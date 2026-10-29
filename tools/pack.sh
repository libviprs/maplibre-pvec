#!/usr/bin/env bash
# Build, pack and check the package in throw-away containers (never publishes).
#   tools/pack.sh            install, unit tests, compat check, build, pack-check
#   tools/pack.sh generate   regenerate compatibility.json and docs/compatibility.md and the lockfile
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
NASSH=${NASSH:-/Users/rom/workspace/libviprs/tools/nas.sh}
NAS=${NAS:-devshell@192.168.0.100}
NAME=${PACK_NAME:-mlp-pack-$(basename "$HERE")}
trap '"$NASSH" clean "$NAME" >/dev/null 2>&1 || true' EXIT
"$NASSH" push "$HERE" "$NAME"
case ${1:-check} in
  generate)
    "$NASSH" run "$NAME" node:22-bookworm-slim "npm install --no-audit --no-fund && npm run compat:generate"
    for f in compatibility.json docs/compatibility.md package-lock.json; do
      ssh -o BatchMode=yes -o LogLevel=ERROR "$NAS" "cat /work/nas-work/$NAME/$f" > "$HERE/$f"
    done ;;
  check)
    "$NASSH" run "$NAME" node:22-bookworm-slim "npm ci --no-audit --no-fund && npm run typecheck && npm test && npm run compat:check && npm run build && npm run pack:check" ;;
esac
