// Collects the per-example result lines into one summary.json, the run record that release/examples-run.json is copied from.
// Exits 1 when an example that ran failed or any host was refused. Fewer than six results is not a failure of the job, but the
// summary says so (`complete: false`) and the release gate counts only a complete record.   node examples/lib/summary.mjs <out dir>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLANNED = 6;
const out = process.argv[2] ?? "examples/out";
const results = readdirSync(out)
  .filter((f) => /^\d\d-.*\.result\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(out, f), "utf8")));
const deniedHosts = [...new Set(results.flatMap((r) => r.deniedHosts ?? []))];
const ok = results.every((r) => r.ok) && deniedHosts.length === 0;
const complete = ok && results.length === PLANNED;
writeFileSync(join(out, "summary.json"), JSON.stringify({ planned: PLANNED, complete, results: results.map(({ example, ok }) => ({ example, ok })), deniedHosts }, null, 2) + "\n");
console.log(JSON.stringify({ examples: results.length, planned: PLANNED, passed: results.filter((r) => r.ok).length, deniedHosts, complete, ok }));
process.exit(ok ? 0 : 1);
