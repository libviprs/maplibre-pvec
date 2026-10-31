// Collects the EVIDENCE102 line the 102-raster Playwright spec prints and writes release/evidence/102-raster.json.
//   node tools/evidence-102.mjs <playwright-log> "<browser, renderer and machine>"
// The numbers come from the run, never from this script.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [log, env] = process.argv.slice(2);
if (!log) { console.error('usage: evidence-102.mjs <log> "<environment>"'); process.exit(2); }
const out = { schema: 1, issue: 102, environment: env ?? "", note: "Measured by tests/e2e/102-raster.spec.ts through the real layer, with a fixture provider in place of the pvec-wasm raster exports." };
for (const line of readFileSync(log, "utf8").split("\n")) {
  const m = /EVIDENCE102 (\{.*\})/.exec(line);
  if (m) Object.assign(out, JSON.parse(m[1]));
}
mkdirSync(path.join(root, "release/evidence"), { recursive: true });
writeFileSync(path.join(root, "release/evidence/102-raster.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
