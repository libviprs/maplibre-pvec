// npm run compat:generate writes the two files; npm run compat:check fails when they differ or the peer range drifts.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  stdin: { contents: 'export * from "./render"; export * from "./matrix";', resolveDir: join(root, "src/compat"), loader: "ts" },
  bundle: true,
  format: "esm",
  write: false,
  platform: "node",
});
const { renderCompatibility, COMPAT, peerRange } = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
const { markdown, json } = renderCompatibility(COMPAT);
const files = { "docs/compatibility.md": markdown, "compatibility.json": json };
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
let bad = 0;
if (pkg.peerDependencies["maplibre-gl"] !== peerRange(COMPAT)) {
  console.error(`peer range ${pkg.peerDependencies["maplibre-gl"]} differs from derived ${peerRange(COMPAT)}`);
  bad++;
}
for (const [f, text] of Object.entries(files)) {
  if (process.argv[2] === "--check") {
    if (readFileSync(join(root, f), "utf8") !== text) (console.error(`${f} is stale, run npm run compat:generate`), bad++);
  } else writeFileSync(join(root, f), text);
}
process.exit(bad ? 1 : 0);
