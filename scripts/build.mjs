// Builds dist/: bundled ESM per entry, the .wasm asset, and rolled-up types. Runs in a container.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolveStagedWasm } from "../tools/staged-wasm.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: { index: "src/index.ts", style: "src/style/index.ts", text: "src/text/index.ts", hatch: "src/hatch/index.ts", wasm: "src/wasm/index.ts" },
  outdir: dist,
  bundle: true,
  splitting: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  sourcemap: false,
  logLevel: "warning",
  absWorkingDir: root,
});
// The evaluator is the pvec-wasm build committed under wasm/ (pinned by wasm/pvec.pin.json, rebuilt by
// tools/pvec-artifacts.sh). PVEC_WASM overrides it: a staged release directory or a module from
// libviprs/pvec tools/wasm-release.sh, checked against its manifest and the pinned ABI version, or a bare
// .wasm to try another build. The loader's export check refuses anything that is not the packed evaluator.
const pin = JSON.parse(readFileSync(join(root, "wasm/pvec.pin.json"), "utf8"));
const artifact = process.env.PVEC_WASM && existsSync(process.env.PVEC_WASM)
  ? resolveStagedWasm(process.env.PVEC_WASM, { abiVersion: pin.abiVersion, sha256: process.env.PVEC_WASM_SHA256 }).file
  : join(root, "wasm/pvec_eval.wasm");
copyFileSync(artifact, join(dist, "pvec_eval.wasm"));
