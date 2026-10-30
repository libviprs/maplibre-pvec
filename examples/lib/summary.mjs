// Collects the per-example result lines into one summary and fails unless all six passed with no
// denied host.   node examples/lib/summary.mjs <out dir>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] ?? "examples/out";
const results = readdirSync(out)
  .filter((f) => /^\d\d-.*\.result\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(out, f), "utf8")));
const deniedHosts = [...new Set(results.flatMap((r) => r.deniedHosts ?? []))];
const ok = results.length === 6 && results.every((r) => r.ok) && deniedHosts.length === 0;
writeFileSync(join(out, "summary.json"), JSON.stringify({ results: results.map(({ example, ok }) => ({ example, ok })), deniedHosts }, null, 2) + "\n");
console.log(JSON.stringify({ examples: results.length, passed: results.filter((r) => r.ok).length, deniedHosts, ok }));
process.exit(ok ? 0 : 1);
