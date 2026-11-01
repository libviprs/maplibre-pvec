// Reads a pvec-wasm release directory staged by libviprs/pvec tools/wasm-release.sh (pvec_wasm_bg.wasm
// plus pvec-wasm-manifest.json) and checks the module against its own manifest. Used by
// scripts/build.mjs (PVEC_WASM) and tools/pvec-artifacts.sh (PVEC_RELEASE).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MANIFEST = "pvec-wasm-manifest.json";

/**
 * `target` is a staged directory or a .wasm file. A directory needs its manifest. A file is checked
 * when a manifest sits beside it, and otherwise taken as an unverified local build (`verified: false`).
 * `abiVersion` is the ABI the caller was written against, `sha256` an optional digest to require.
 */
export function resolveStagedWasm(target, { abiVersion, sha256 } = {}) {
  const isDir = statSync(target).isDirectory();
  const dir = isDir ? target : path.dirname(target);
  const manifestFile = path.join(dir, MANIFEST);
  if (!existsSync(manifestFile)) {
    if (isDir) throw new Error(`${target} has no ${MANIFEST}, it is not a staged pvec-wasm release`);
    return { file: target, verified: false };
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const file = isDir ? path.join(dir, manifest.wasm.file) : target;
  const have = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (have !== manifest.wasm.sha256) throw new Error(`${file}: sha256 ${have} differs from the manifest's ${manifest.wasm.sha256}`);
  if (sha256 && have !== sha256) throw new Error(`${file}: sha256 ${have} differs from the required ${sha256}`);
  if (abiVersion !== undefined && manifest.abiVersion !== abiVersion) {
    throw new Error(`${file}: the module has ABI version ${manifest.abiVersion}, this package is written against ${abiVersion}`);
  }
  return { file, sha256: have, bytes: manifest.wasm.bytes, abiVersion: manifest.abiVersion, commit: manifest.commit, verified: true };
}

/** The names from `names` that the module's bytes do not contain: the self-test of a staged or pinned module for the raster group (wasm-bindgen keeps export names as plain strings). */
export function missingRasterExports(file, names) {
  const bytes = readFileSync(file);
  return names.filter((n) => !bytes.includes(Buffer.from(n)));
}
