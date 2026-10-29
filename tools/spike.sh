#!/usr/bin/env bash
# Run spike harnesses in one throw-away Playwright container on the docker host and copy each
# results.json back. Launch through the Playwright lock:
#   /Users/rom/workspace/xdg-pw-lock.sh tools/spike.sh maplibre-surface [workers ...]
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
NASSH=${NASSH:-/Users/rom/workspace/libviprs/tools/nas.sh}
NAS=${NAS:-devshell@192.168.0.100}
[ $# -ge 1 ] || { echo "usage: $0 <spike> [<spike> ...]" >&2; exit 2; }
NAME=mlp-spike-$$
PW_IMAGE=${PW_IMAGE:-mcr.microsoft.com/playwright:v1.48.2-jammy}
trap '"$NASSH" clean "$NAME" >/dev/null 2>&1 || true' EXIT
"$NASSH" push "$HERE" "$NAME"
cmd="npm install --no-audit --no-fund >/dev/null 2>&1"
for s in "$@"; do cmd="$cmd; node spikes/$s/run.mjs || echo SPIKE-FAILED-$s"; done
"$NASSH" run "$NAME" "$PW_IMAGE" "$cmd"
for s in "$@"; do
  ssh -o BatchMode=yes -o LogLevel=ERROR "$NAS" "cat /work/nas-work/$NAME/spikes/$s/results.json" > "$HERE/spikes/$s/results.json.new" && mv "$HERE/spikes/$s/results.json.new" "$HERE/spikes/$s/results.json" || echo "no results for $s"
done
