#!/usr/bin/env bash
# Rebuilds tests/fixtures/raster/ (the decode fixtures of the browser grid, #107) in a throw-away container on the docker host.
#   tools/raster-fixtures.sh            writes the fixtures
#   tools/raster-fixtures.sh --check    rebuilds and fails when the committed bytes differ, writes nothing
# Pillow is pinned so the bytes are reproducible. The container needs the network once, for pip.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
NASSH=${NASSH:-/Users/rom/workspace/libviprs/tools/nas.sh}
NAS=${NAS:-devshell@192.168.0.100}
NAME=mlp-raster-fixtures-$$
trap '"$NASSH" clean "$NAME" >/dev/null 2>&1 || true' EXIT
mkdir -p "$HERE/.cache"
STAGE=$(mktemp -d "$HERE/.cache/raster-fixtures.XXXXXX")
"$NASSH" push "$HERE/tools" "$NAME" >/dev/null
"$NASSH" run "$NAME" python:3.12-slim 'pip install --quiet --no-cache-dir pillow==11.0.0 >/dev/null 2>&1 && mkdir -p out && python3 raster_fixtures.py out' >&2
ssh -o BatchMode=yes -o LogLevel=ERROR "$NAS" "tar -C /work/nas-work/$NAME/out -cf - ." | tar -C "$STAGE" -xf -
if [ "${1:-}" = "--check" ]; then
  diff -r "$STAGE" "$HERE/tests/fixtures/raster" && echo "raster fixtures are current"
  rc=$?
else
  mkdir -p "$HERE/tests/fixtures/raster"
  cp "$STAGE"/* "$HERE/tests/fixtures/raster/"
  rc=0
fi
mv "$STAGE" "$STAGE.superseded"
exit $rc
