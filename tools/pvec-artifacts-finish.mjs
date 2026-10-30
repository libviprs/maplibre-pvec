// Second half of tools/pvec-artifacts.sh: takes the build output directory, writes or checks the
// committed artifacts and their digests.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [out, mode] = process.argv.slice(2);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const pinFile = path.join(root, "wasm/pvec.pin.json");
const pin = JSON.parse(readFileSync(pinFile, "utf8"));
const [wasmBindgen, rustc] = readFileSync(path.join(out, "versions.txt"), "utf8").trim().split("\n");

const wasm = readFileSync(path.join(out, "pvec_eval.wasm"));
const outcomes = JSON.parse(readFileSync(path.join(out, "pvec/emitted.json"), "utf8"));
const artifacts = {};
const notEmitted = {};
const files = new Map();
for (const o of outcomes) {
  if (o.status === "EMITTED") {
    const bytes = readFileSync(path.join(out, "pvec", `${o.fixtureId}.pvec`));
    artifacts[o.fixtureId] = { bytes: bytes.length, sha256: sha(bytes) };
    files.set(`${o.fixtureId}.pvec`, bytes);
  } else if (o.status !== "QUARANTINED") {
    notEmitted[o.fixtureId] = { status: o.status, reason: o.reason };
  }
}
const index = {
  schema: 1,
  generator: "pvec-testkit generate_all (P2.4)",
  pvecCommit: pin.pvecCommit,
  corpusRevision: "r0-open",
  note: "pvec vendors the r0-open bundle at libviprs/pvec-gold-fixtures f94f7f22. Fixtures whose record changed since then are in notEmitted until pvec re-pins.",
  artifacts,
  notEmitted,
};
const nextPin = { ...pin, wasmBindgen, rustc, wasm: { file: "wasm/pvec_eval.wasm", bytes: wasm.length, sha256: sha(wasm) } };
const text = (v) => JSON.stringify(v, null, 2) + "\n";

if (mode === "--check") {
  const same =
    text(nextPin) === readFileSync(pinFile, "utf8") &&
    text(index) === readFileSync(path.join(root, "tests/fixtures/pvec/index.json"), "utf8") &&
    [...files].every(([n, b]) => sha(readFileSync(path.join(root, "tests/fixtures/pvec", n))) === sha(b));
  if (!same) { console.error("the committed pvec artifacts differ from a rebuild"); process.exit(1); }
  console.log("the committed pvec artifacts match a rebuild");
} else {
  mkdirSync(path.join(root, "tests/fixtures/pvec"), { recursive: true });
  writeFileSync(path.join(root, "wasm/pvec_eval.wasm"), wasm);
  for (const [n, b] of files) writeFileSync(path.join(root, "tests/fixtures/pvec", n), b);
  writeFileSync(path.join(root, "tests/fixtures/pvec/index.json"), text(index));
  writeFileSync(pinFile, text(nextPin));
  console.log(`wrote wasm/pvec_eval.wasm (${wasm.length} bytes) and ${files.size} .pvec files`);
}
