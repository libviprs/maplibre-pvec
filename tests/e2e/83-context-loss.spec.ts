import { expect, test } from "@playwright/test";
import { H, launch, rig } from "./harness/layer-run";

// Issue 83 (M7.2): a forced WEBGL_lose_context, then a restore, rebuilds from retained bytes.
test.use({ launchOptions: launch });

test.describe("issue 83 context loss", () => {
  test("snapshot after loss and restore matches the one before, with zero new range requests", async ({ page }) => {
    const r = await rig(page);
    try {
      await H(page, "open", { fixture: r.url, layer: true, cursor: true, wasm: "ok", debugState: true });
      await H(page, "snap", "before");
      const requestsBefore = r.gets();
      expect(requestsBefore, "the bootstrap did read the container").toBeGreaterThan(0);
      const probe = await H<{ red: number }>(page, "strokeProbe", "before");
      expect(probe.red).toBeGreaterThan(300);

      await H(page, "loseAndRestore");
      await H(page, "snap", "after");

      expect(r.gets() - requestsBefore, "new range requests after the restore").toBe(0);
      const d = await H<{ pixels: number; differing: number }>(page, "diff", ["before", "after"]);
      expect(d.differing / d.pixels).toBeLessThanOrEqual(0.001);
      const info = await H<{ errors: unknown[]; diagnostics: { contextLosses: number } }>(page, "info");
      expect(info.errors).toEqual([]);
      expect(info.diagnostics.contextLosses).toBe(1);
    } finally {
      await r.stop();
    }
  });
});
