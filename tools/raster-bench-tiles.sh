#!/usr/bin/env bash
# Rebuilds the tiles of the raster hardware run (#108) in a throw-away container on the docker host.
#   tools/raster-bench-tiles.sh            writes .cache/hw-tiles/ (not committed) and bench/hw/raster-tiles.json (the pinned digests)
#   tools/raster-bench-tiles.sh --check    rebuilds and fails when the committed manifest differs, writes nothing
# Pillow is pinned so the bytes are reproducible. The container needs the network once, for pip.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
NASSH=${NASSH:-/Users/rom/workspace/libviprs/tools/nas.sh}
NAS=${NAS:-devshell@192.168.0.100}
NAME=mlp-raster-bench-tiles-$$
trap '"$NASSH" clean "$NAME" >/dev/null 2>&1 || true' EXIT
mkdir -p "$HERE/.cache"
STAGE=$(mktemp -d "$HERE/.cache/hw-tiles.XXXXXX")
"$NASSH" push "$HERE/tools" "$NAME" >/dev/null
"$NASSH" run "$NAME" python:3.12-slim 'pip install --quiet --no-cache-dir pillow==11.0.0 >/dev/null 2>&1 && mkdir -p out && python3 raster_bench_tiles.py out' >&2
ssh -o BatchMode=yes -o LogLevel=ERROR "$NAS" "tar -C /work/nas-work/$NAME/out -cf - ." | tar -C "$STAGE" -xf -
if [ "${1:-}" = "--check" ]; then
  diff "$STAGE/raster-tiles.json" "$HERE/bench/hw/raster-tiles.json" && echo "raster bench tiles are current"
  rc=$?
else
  mkdir -p "$HERE/.cache/hw-tiles"
  cp "$STAGE"/* "$HERE/.cache/hw-tiles/"
  cp "$STAGE/raster-tiles.json" "$HERE/bench/hw/raster-tiles.json"
  rc=0
fi
mv "$STAGE" "$STAGE.superseded"
exit $rc
