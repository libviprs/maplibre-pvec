import { expect, test } from "@playwright/test";
import { H, launch, rig } from "./harness/layer-run";

// Issue 83 (M7.6): a blocked WASM evaluator is one error event, and MapLibre's own layers keep rendering.
test.use({ launchOptions: launch });

test.describe("issue 83 WASM-blocked path through the real layer", () => {
  test("onAdd fails with wasm_unavailable, once, with no range request, and the map renders as without the layer", async ({ page }) => {
    const r = await rig(page);
    try {
      await page.route("**/83-missing.wasm", (route) => route.fulfill({ status: 404, body: "no" }));
      await H(page, "open", { fixture: r.url, layer: false, cursor: false, wasm: "ok" });
      await H(page, "snap", "without");
      await H(page, "open", { fixture: r.url, layer: true, cursor: true, wasm: "blocked" });
      await H(page, "snap", "blocked");
      await H(page, "repaint");

      const info = await H<{ errors: { code: string }[]; mapErrors: number }>(page, "info");
      expect(info.errors.map((e) => e.code)).toEqual(["wasm_unavailable"]);
      expect(info.mapErrors).toBe(0);
      expect(r.gets(), "no range request before the evaluator is known good").toBe(0);

      const d = await H<{ pixels: number; differing: number }>(page, "diff", ["without", "blocked"]);
      expect(d.differing / d.pixels).toBeLessThanOrEqual(0.001);
      console.log("EVIDENCE83 " + JSON.stringify({ wasmBlocked: { code: info.errors[0]!.code, errorEvents: info.errors.length, rangeRequests: r.gets(), mapLibrePixelDiff: d.differing / d.pixels } }));
    } finally {
      await r.stop();
    }
  });
});
