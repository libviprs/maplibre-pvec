#!/usr/bin/env bash
# Run a pure-Node spike with outbound network denied (--network none); only the in-process
# loopback origin works. Usage: tools/spike-node.sh range-bootstrap
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
NASSH=${NASSH:-/Users/rom/workspace/libviprs/tools/nas.sh}
NAS=${NAS:-devshell@192.168.0.100}
SPIKE=${1:?spike directory name under spikes/}
NAME=mlp-spike-$SPIKE
trap '"$NASSH" clean "$NAME" >/dev/null 2>&1 || true' EXIT
"$NASSH" push "$HERE" "$NAME"
ssh -o BatchMode=yes -o LogLevel=ERROR "$NAS" "docker run --rm --network none --platform linux/amd64 -v /work/nas-work/$NAME:/work -w /work node:22-bookworm-slim node spikes/$SPIKE/run.mjs"
ssh -o BatchMode=yes -o LogLevel=ERROR "$NAS" "cat /work/nas-work/$NAME/spikes/$SPIKE/results.json" > "$HERE/spikes/$SPIKE/results.json"
