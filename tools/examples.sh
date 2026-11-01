#!/usr/bin/env bash
# Runs the examples in the Playwright container on the docker host and pulls the screenshots back
# into examples/out/. Drive it through /Users/rom/workspace/xdg-pw-lock.sh.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
NASSH=${NASSH:-/Users/rom/workspace/libviprs/tools/nas.sh}
NAS=${NAS:-devshell@192.168.0.100}
NAME=${EX_NAME:-mlp-ex-$(basename "$HERE")}
PW_IMAGE=${PW_IMAGE:-mcr.microsoft.com/playwright:v1.48.2-jammy}
RUST_IMAGE=${RUST_IMAGE:-rust:1.99.1-bookworm}
GEN=mlp-ex-large-$$
trap '"$NASSH" clean "$NAME" >/dev/null 2>&1 || true; "$NASSH" clean "$GEN" >/dev/null 2>&1 || true' EXIT
"$NASSH" push "$HERE" "$NAME"
# Example 04's file is not in the repository: pvec's seeded tiler writes it (libviprs/pvec#251) from the commit and arguments in
# examples/04-large-budget/fixture.json. PVEC_SRC is a checkout of libviprs/pvec at that commit; the file is built in a rust container
# and copied next to the pushed tree, and run.mjs refuses it unless its sha256 is the recorded one.
FIX="$HERE/examples/04-large-budget/fixture.json"
if [ -n "${PVEC_SRC:-}" ]; then
  want=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["pvecCommit"])' "$FIX")
  have=$(git -C "$PVEC_SRC" rev-parse HEAD)
  [ "$want" = "$have" ] || { echo "PVEC_SRC is at $have, fixture.json says $want" >&2; exit 1; }
  args=$(python3 -c 'import json,sys;print(" ".join(json.load(open(sys.argv[1]))["args"]))' "$FIX")
  "$NASSH" push "$PVEC_SRC" "$GEN" >/dev/null
  "$NASSH" run "$GEN" "$RUST_IMAGE" "export CARGO_TARGET_DIR=/tmp/target CARGO_HOME=/tmp/cargo; mkdir -p /work/out && cargo run --release --locked -q -p pvec-testkit --example emit_large_raster -- /work/out/large.pvec $args"
  ssh -o BatchMode=yes -o LogLevel=ERROR "$NAS" "mkdir -p /work/nas-work/$NAME/fixtures-large && cp /work/nas-work/$GEN/out/large.pvec /work/nas-work/$NAME/fixtures-large/large.pvec"
fi
set +e
"$NASSH" run "$NAME" "$PW_IMAGE" "mkdir -p /work/examples-out && examples/run-all.sh"
rc=$?
set -e
mkdir -p "$HERE/examples/out"
ssh -o BatchMode=yes -o LogLevel=ERROR "$NAS" "cd /work/nas-work/$NAME/examples-out 2>/dev/null && tar -cf - ." | tar -xf - -C "$HERE/examples/out" || true
exit $rc
