// Passes when a seeded 8192 by 8192 raster with 440 strokes is toured under a 48 MiB GPU tier without one frame over it (and with
// the tier well used), the JS heap neither leaks nor passes the 256 MiB decoded ceiling, the strokes refine with generations that
// only go up, and the raster's pixels are the pattern the tiler painted. The file is built by tools/examples.sh from pvec's tiler
// (fixture.json). Launch through xdg-pw-lock.sh.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runExample } from "../lib/run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MiB = 1024 * 1024;
const record = JSON.parse(readFileSync(join(here, "fixture.json"), "utf8"));
const file = join(here, "../../fixtures-large/large.pvec");
if (!existsSync(file)) {
  console.error("fixtures-large/large.pvec is missing: run this through tools/examples.sh, which builds it with pvec's emit_large_raster");
  process.exit(1);
}
const bytes = new Uint8Array(readFileSync(file));
const digest = createHash("sha256").update(bytes).digest("hex");

await runExample({
  name: "04-large-budget",
  fixtures: { "/fixtures/large.pvec": bytes },
  launchArgs: ["--js-flags=--expose-gc"],
  timeoutMs: 280_000,
  check: (r) => {
    const f = [];
    if (digest !== record.sha256) f.push(`the fixture is ${digest}, fixture.json says ${record.sha256}`);
    if (r.errors.length) f.push(`layer errors: ${r.errors}`);
    r.stops.forEach((s) => {
      const want = s.zoom === 12.5 ? 0.4 : 0.9;
      if (s.painted / s.total < want) f.push(`zoom ${s.zoom}: the raster covers ${s.painted} of ${s.total} sample points, want at least ${want}`);
    });
    if (r.overBudget !== 0) f.push(`${r.overBudget} of ${r.framesSeen} frames had a GPU tier above ${r.gpuBudget / MiB} MiB`);
    if (r.peakGpu > r.gpuBudget) f.push(`peak GPU tier ${r.peakGpu} is over the budget ${r.gpuBudget}`);
    if (r.peakGpu < 16 * MiB) f.push(`peak GPU tier ${(r.peakGpu / MiB).toFixed(1)} MiB: the budget was never under load`);
    if (r.heap.end - r.heap.base > 32 * MiB) f.push(`the heap grew ${((r.heap.end - r.heap.base) / MiB).toFixed(1)} MiB over the tour after a collection`);
    if (r.heap.peak > 256 * MiB) f.push(`peak JS heap ${(r.heap.peak / MiB).toFixed(1)} MiB is over the 256 MiB decoded ceiling`);
    const t0 = r.events.filter((e) => e.type === "tier0complete");
    if (t0.length !== 1) f.push(`tier0complete fired ${t0.length} times`);
    const last = new Map();
    let refinements = 0;
    for (const e of r.events.filter((x) => x.type === "refinement")) {
      refinements++;
      if (e.generation !== (last.get(e.entityId) ?? 0) + 1) f.push(`entity ${e.entityId}: generation ${e.generation} after ${last.get(e.entityId) ?? 0}`);
      last.set(e.entityId, e.generation);
      if (!(e.priorErrorPx > 1)) f.push(`entity ${e.entityId}: priorErrorPx ${e.priorErrorPx}`);
      if (!(Math.abs(e.nextErrorPx - 0.5) < 0.01)) f.push(`entity ${e.entityId}: nextErrorPx ${e.nextErrorPx}`);
    }
    if (refinements < 5) f.push(`only ${refinements} refinement events over the tour`);
    if (r.pattern.tested < 200) f.push(`only ${r.pattern.tested} raster pixels were compared with the tiler's pattern`);
    if (r.pattern.wrongCount) f.push(`${r.pattern.wrongCount} raster pixels differ from the pattern, first ${JSON.stringify(r.pattern.wrong)}`);
    console.log(JSON.stringify({ budget: { gpuPeakMiB: +(r.peakGpu / MiB).toFixed(2), heapPeakMiB: +(r.heap.peak / MiB).toFixed(1), heapGrowthMiB: +((r.heap.end - r.heap.base) / MiB).toFixed(1), frames: r.framesSeen, refinements, patternTested: r.pattern.tested } }));
    return f;
  },
});
