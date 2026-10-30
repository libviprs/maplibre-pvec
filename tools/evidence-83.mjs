// Collects the EVIDENCE83 lines the 83-* Playwright specs print and writes release/evidence/83-wired-layer.json.
//   node tools/evidence-83.mjs <playwright-log> "<browser and renderer>"
// The numbers come from the run, never from this script. The release gate reads the file and checks the limits itself.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [log, env] = process.argv.slice(2);
if (!log) { console.error('usage: evidence-83.mjs <log> "<environment>"'); process.exit(2); }
const out = { schema: 1, issue: 83, environment: env ?? "", note: "Measured by tests/e2e/83-*.spec.ts. Stand-in evaluator and cursor on the map specs, the installed tarball for the tarball spec." };
for (const line of readFileSync(log, "utf8").split("\n")) {
  const m = /EVIDENCE83 (\{.*\})/.exec(line);
  if (m) Object.assign(out, JSON.parse(m[1]));
}
mkdirSync(path.join(root, "release/evidence"), { recursive: true });
writeFileSync(path.join(root, "release/evidence/83-wired-layer.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
