import { expect, test } from "@playwright/test";
import { H, launch, rig, SNAPSHOT_MATCH } from "./harness/layer-run";

// Issue 83 (M7.2): a forced WEBGL_lose_context, then a restore, rebuilds from retained bytes.
// The layer runs on a real WebGL2 canvas through its public onAdd and render, with a small camera standing in for the map.
test.use({ launchOptions: launch });

test.describe("issue 83 context loss", () => {
  test("snapshot after loss and restore matches the one before, with zero new range requests", async ({ page }) => {
    const r = await rig(page);
    try {
      await H(page, "openStandalone", { fixture: r.url });
      const before = await H<{ red: number }>(page, "frameStandalone", "before");
      const requestsBefore = r.gets();
      expect(requestsBefore, "the bootstrap did read the container").toBeGreaterThan(0);
      expect(before.red, "the strokes are on screen before the loss").toBeGreaterThan(300);

      await H(page, "loseAndRestoreStandalone");
      const after = await H<{ red: number }>(page, "frameStandalone", "after");

      expect(r.gets() - requestsBefore, "new range requests after the restore").toBe(0);
      expect(after.red, "the strokes are back").toBeGreaterThan(300);
      const d = await H<{ pixels: number; differing: number }>(page, "compare", ["before", "after"]);
      expect(d.differing / d.pixels).toBeLessThanOrEqual(SNAPSHOT_MATCH);
      const info = await H<{ errors: unknown[]; stateDiffs: string[]; diagnostics: { contextLosses: number } }>(page, "info");
      expect(info.errors).toEqual([]);
      expect(info.stateDiffs).toEqual([]);
      expect(info.diagnostics.contextLosses).toBe(1);
      console.log("EVIDENCE83 " + JSON.stringify({ contextLoss: { forced: true, contextLosses: info.diagnostics.contextLosses, newRangeRequests: r.gets() - requestsBefore, snapshotDiff: d.differing / d.pixels } }));
    } finally {
      await r.stop();
    }
  });
});
