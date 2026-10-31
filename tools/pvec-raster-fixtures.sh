#!/usr/bin/env bash
# Builds tests/fixtures/pvec-raster/ in a throw-away container on the docker host: a file with rasters and one file per tile of pvec's
# hostile corpus (13 refused, 12 accepted), written by pvec's test-only writer. PVEC_SRC has to be at the commit in wasm/pvec.pin.json.
#   PVEC_SRC=/path/to/pvec-checkout tools/pvec-raster-fixtures.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
NASSH=${NASSH:-/Users/rom/workspace/libviprs/tools/nas.sh}
NAS=${NAS:-devshell@192.168.0.100}
SRC=${PVEC_SRC:?set PVEC_SRC to a libviprs/pvec checkout}
NAME=mlp-pvec-raster-$$
want=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pvecCommit)' "$HERE/wasm/pvec.pin.json")
have=$(git -C "$SRC" rev-parse HEAD)
[ "$want" = "$have" ] || { echo "PVEC_SRC is at $have, the pin says $want" >&2; exit 1; }
trap '"$NASSH" clean "$NAME" >/dev/null 2>&1 || true' EXIT
"$NASSH" push "$SRC" "$NAME" >/dev/null
ssh -o BatchMode=yes -o LogLevel=ERROR "$NAS" "cat > /work/nas-work/$NAME/emit.rs" < "$HERE/tools/pvec-raster-emit.rs"
"$NASSH" run "$NAME" rust:1.99.0-bookworm '
set -e
export CARGO_TARGET_DIR=/tmp/target CARGO_HOME=/tmp/cargo
mkdir -p crates/pvec-testkit/examples && cp emit.rs crates/pvec-testkit/examples/pvec_raster_emit.rs
cargo run --locked -q -p pvec-testkit --example pvec_raster_emit -- /work/out
' >&2
OUT=$(mktemp -d "${TMPDIR:-/tmp}/pvec-raster.XXXXXX")
ssh -o BatchMode=yes -o LogLevel=ERROR "$NAS" "tar -C /work/nas-work/$NAME/out -cf - ." | tar -C "$OUT" -xf -
mkdir -p "$HERE/tests/fixtures/pvec-raster"

cp -R "$OUT"/. "$HERE/tests/fixtures/pvec-raster/"
node -e '
const fs=require("fs"),c=require("crypto"),d=process.argv[1];
const rows=JSON.parse(fs.readFileSync(d+"/tiles.json","utf8")).map(r=>{const b=fs.readFileSync(`${d}/${r.kind}/${r.name}.pvec`);return {...r,bytes:b.length,sha256:c.createHash("sha256").update(b).digest("hex")}});
const s=fs.readFileSync(d+"/synthetic.pvec");
fs.writeFileSync(d+"/index.json",JSON.stringify({pvecCommit:process.argv[2],synthetic:{bytes:s.length,sha256:c.createHash("sha256").update(s).digest("hex")},tiles:rows},null,2)+"\n");
fs.unlinkSync(d+"/tiles.json");
' "$HERE/tests/fixtures/pvec-raster" "$want"
mv "$OUT" "$OUT.superseded"
echo "wrote tests/fixtures/pvec-raster"
