#!/usr/bin/env bash
# Runs every example inside the Playwright container, with the package taken from a packed tarball
# installed into a clean directory (nothing from src/ is reachable at runtime).
#   examples/run-all.sh              from the repo root, via tools/examples.sh on the docker host
set -euo pipefail
npm ci --no-audit --no-fund
npm run build
mkdir -p /tmp/consumer /tmp/packed
TARBALL=$(npm pack --silent --pack-destination /tmp/packed)
(cd /tmp/consumer && npm init -y >/dev/null && npm install --no-audit --no-fund "/tmp/packed/$TARBALL" >/dev/null)
PKG=/tmp/consumer/node_modules/maplibre-pvec
status=0
for dir in examples/0*/; do
  [ -f "$dir/run.mjs" ] || continue
  node "$dir/run.mjs" --pkg "$PKG" --out /work/examples-out || status=1
done
exit $status
