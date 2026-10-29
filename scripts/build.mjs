// Builds dist/: bundled ESM per entry, the .wasm asset, and rolled-up types. Runs in a container.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
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
// PVEC_WASM points at the evaluator artifact from libviprs/pvec once it exists. Until then the
// committed boundary probe is shipped under the same name so the acquisition paths are real.
const artifact = process.env.PVEC_WASM && existsSync(process.env.PVEC_WASM) ? process.env.PVEC_WASM : join(root, "wasm/probe.wasm");
copyFileSync(artifact, join(dist, "pvec_eval.wasm"));
