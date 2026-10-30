import { expect, test } from "@playwright/test";
import { H, launch, rig } from "./harness/layer-run";

// Issue 83: the wired layer next to MapLibre's own layers. Run via /Users/rom/workspace/xdg-pw-lock.sh.
test.use({ launchOptions: launch });

type Diff = { pixels: number; differing: number; outsideBand: number };
type Probe = { red: number; atMidpoint: number[] };

test.describe("issue 83 coexistence with MapLibre's own layers", () => {
  test("the add-on draws where the source says, and outside its strokes every pixel is MapLibre's own (0.1 percent)", async ({ page }) => {
    const r = await rig(page);
    try {
      await H(page, "open", { fixture: r.url, layer: false, cursor: false, wasm: "ok" });
      await H(page, "snap", "without");
      await H(page, "open", { fixture: r.url, layer: true, cursor: true, wasm: "ok", debugState: true });
      await H(page, "snap", "with");

      const probe = await H<Probe>(page, "strokeProbe", "with");
      expect(probe.red, "the stroke pipeline drew into the map").toBeGreaterThan(300);
      expect(probe.atMidpoint[0], "red under the source point (50, 10)").toBeGreaterThan(170);
      expect(probe.atMidpoint[2]).toBeLessThan(60);

      const d = await H<Diff>(page, "diff", ["without", "with"]);
      expect(d.differing, "the add-on changed pixels").toBeGreaterThan(0);
      expect(d.outsideBand / d.pixels).toBeLessThanOrEqual(0.001);

      const info = await H<{ errors: unknown[]; mapErrors: number; stateDiffs: string[]; frames: number }>(page, "info");
      expect(info.errors).toEqual([]);
      expect(info.mapErrors).toBe(0);
      expect(info.frames).toBeGreaterThan(0);
      expect(info.stateDiffs, "GlStateGuard saw no state left behind in any frame").toEqual([]);
    } finally {
      await r.stop();
    }
  });

  test("a symbol layer above the add-on renders exactly as it does without it (stencil and state check)", async ({ page }) => {
    const r = await rig(page);
    try {
      await H(page, "open", { fixture: r.url, layer: false, cursor: false, wasm: "ok" });
      await H(page, "snap", "without");
      // Same strokes are not drawn here (no cursor), so the whole frame, icons included, must be identical.
      await H(page, "open", { fixture: r.url, layer: true, cursor: false, wasm: "ok", debugState: true });
      await H(page, "snap", "with");
      const d = await H<Diff>(page, "diff", ["without", "with"]);
      expect(d.differing / d.pixels).toBeLessThanOrEqual(0.001);
      const info = await H<{ stateDiffs: string[]; errors: unknown[] }>(page, "info");
      expect(info.errors).toEqual([]);
      expect(info.stateDiffs).toEqual([]);
    } finally {
      await r.stop();
    }
  });
});
