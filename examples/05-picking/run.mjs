// Passes when each probe's answer matches the maths: the entity, the distance in CSS pixels to 0.05 px, an empty answer where nothing
// is under the point, a region answer that is exact and not a bounds superset. Launch through xdg-pw-lock.sh.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runExample } from "../lib/run.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fx = (id) => new Uint8Array(readFileSync(join(root, "tests/fixtures/pvec", `${id}.pvec`)));
const SLACK_PX = 0.05;

await runExample({
  name: "05-picking",
  fixtures: { "/fixtures/lines.pvec": fx("layer-state-001"), "/fixtures/circle.pvec": fx("circle-001"), "/fixtures/bezier.pvec": fx("bezier-d3-001") },
  check: (r) => {
    const f = [];
    if (r.errors.length) f.push(`layer errors: ${r.errors}`);
    if (r.probes.length !== 9) f.push(`${r.probes.length} probes ran, want 9`);
    for (const p of r.probes) {
      const got = p.got, want = p.want;
      if (got.length !== want.length) {
        f.push(`${p.name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
        continue;
      }
      want.forEach((w, i) => {
        const g = got[i];
        if (typeof w === "string") {
          if (g !== w) f.push(`${p.name}: entity ${g}, want ${w}`);
          return;
        }
        if (g.id !== w.id) f.push(`${p.name}: entity ${g.id}, want ${w.id}`);
        if (!(Math.abs(g.distancePx - w.distancePx) <= SLACK_PX)) f.push(`${p.name}: ${g.distancePx} px away, the maths says ${w.distancePx}`);
        if (g.complete !== true) f.push(`${p.name}: answer is not complete`);
        if (g.generation < 0) f.push(`${p.name}: generation ${g.generation}`);
      });
    }
    return f;
  },
});
