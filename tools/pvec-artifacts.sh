#!/usr/bin/env bash
# Builds the two artifacts this package takes from libviprs/pvec, in a throw-away container on the
# docker host (nothing but ssh, tar and the nas.sh wrapper runs on this machine):
#   wasm/pvec_eval.wasm           the pvec-wasm crate for wasm32, run through wasm-bindgen
#   tests/fixtures/pvec/*.pvec    the canonical artifacts (P2.4) for every r0-open fixture pvec can hold
#   tests/fixtures/pvec/index.json  sizes, digests and the reason for every fixture it refused
#
#   PVEC_SRC=/path/to/pvec-checkout tools/pvec-artifacts.sh [--check]
#
# PVEC_SRC has to be checked out at the commit in wasm/pvec.pin.json. --check rebuilds and fails when
# the committed bytes differ, it writes nothing.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
NASSH=${NASSH:-/Users/rom/workspace/libviprs/tools/nas.sh}
NAS=${NAS:-devshell@192.168.0.100}
RUST_IMAGE=${RUST_IMAGE:-rust:1.99.0-bookworm}
SRC=${PVEC_SRC:?set PVEC_SRC to a libviprs/pvec checkout}
NAME=mlp-pvec-artifacts-$$
PIN="$HERE/wasm/pvec.pin.json"

want=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pvecCommit)' "$PIN")
have=$(git -C "$SRC" rev-parse HEAD)
[ "$want" = "$have" ] || { echo "PVEC_SRC is at $have, the pin says $want" >&2; exit 1; }

trap '"$NASSH" clean "$NAME" >/dev/null 2>&1 || true' EXIT
"$NASSH" push "$SRC" "$NAME" >/dev/null
ssh -o BatchMode=yes -o LogLevel=ERROR "$NAS" "cat > /work/nas-work/$NAME/emit_corpus.rs" < "$HERE/tools/pvec-emit-corpus.rs"
"$NASSH" run "$NAME" "$RUST_IMAGE" '
set -e
export CARGO_TARGET_DIR=/tmp/target CARGO_HOME=/tmp/cargo
rustup target add wasm32-unknown-unknown >/dev/null 2>&1
wb=$(awk "/^name = \"wasm-bindgen\"/{getline; gsub(/[^0-9.]/,\"\"); print; exit}" Cargo.lock)
cargo build --release --locked -p pvec-wasm --target wasm32-unknown-unknown 2>&1 | tail -1
cargo install wasm-bindgen-cli --version "$wb" --locked >/dev/null 2>&1
/tmp/cargo/bin/wasm-bindgen --target web --no-typescript --out-dir /tmp/bg /tmp/target/wasm32-unknown-unknown/release/pvec_wasm.wasm
mkdir -p crates/pvec-testkit/examples && cp emit_corpus.rs crates/pvec-testkit/examples/emit_corpus.rs
cargo run --locked -q -p pvec-testkit --example emit_corpus -- /tmp/pvec 2>/dev/null
mkdir -p /work/out && cp /tmp/bg/pvec_wasm_bg.wasm /work/out/pvec_eval.wasm && cp -r /tmp/pvec /work/out/pvec
echo "wasm-bindgen $wb" > /work/out/versions.txt; rustc --version >> /work/out/versions.txt
' >&2

OUT=$(mktemp -d "${TMPDIR:-/tmp}/pvec-artifacts.XXXXXX")
ssh -o BatchMode=yes -o LogLevel=ERROR "$NAS" "tar -C /work/nas-work/$NAME/out -cf - ." | tar -C "$OUT" -xf -
node "$HERE/tools/pvec-artifacts-finish.mjs" "$OUT" ${1:-}
rm -rf "$OUT"
