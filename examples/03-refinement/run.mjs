// Passes when the layer reports tier0complete once, then refinement with generations 1 and 2 for the circle, each from more than 1 px
// of displayed error to the target, and the analytic circle has ink under it after each. Launch through xdg-pw-lock.sh.
import { circleFixture } from "../lib/fixtures.mjs";
import { runExample } from "../lib/run.mjs";

await runExample({
  name: "03-refinement",
  fixtures: { "/fixtures/circle.pvec": circleFixture() },
  check: (r) => {
    const f = [];
    if (r.errors.length) f.push(`layer errors: ${r.errors}`);
    const t0 = r.events.filter((e) => e.type === "tier0complete");
    const ref = r.events.filter((e) => e.type === "refinement");
    if (t0.length !== 1) f.push(`tier0complete fired ${t0.length} times`);
    else if (t0[0].blocksUsed < 1) f.push(`tier0complete blocksUsed ${t0[0].blocksUsed}`);
    if (r.events[0]?.type !== "tier0complete") f.push(`first event is ${r.events[0]?.type}, not tier0complete`);
    if (ref.length !== 2) f.push(`${ref.length} refinement events, want 2: ${JSON.stringify(ref)}`);
    ref.forEach((e, i) => {
      if (e.entityId !== ref[0].entityId) f.push(`refinement ${i} is for another entity ${e.entityId}`);
      if (e.generation !== i + 1) f.push(`refinement ${i} has generation ${e.generation}, want ${i + 1}`);
      if (!(e.priorErrorPx > 1)) f.push(`refinement ${i} priorErrorPx ${e.priorErrorPx} is not above the 1 px threshold`);
      if (!(Math.abs(e.nextErrorPx - 0.5) < 0.01)) f.push(`refinement ${i} nextErrorPx ${e.nextErrorPx} is not the 0.5 px target`);
    });
    for (const s of r.stages) {
      if (s.tested < 100) f.push(`zoom ${s.zoom}: only ${s.tested} points of the circle were on screen`);
      if (s.bad.length) f.push(`zoom ${s.zoom}: no ink under ${s.bad.length} of ${s.tested} points of the circle, first ${JSON.stringify(s.bad.slice(0, 3))}`);
    }
    if (r.afterZoomOut !== 0) f.push(`${r.afterZoomOut} events after zooming out`);
    return f;
  },
});
