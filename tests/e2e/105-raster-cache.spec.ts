import { expect, test } from "@playwright/test";
import { launch, SNAPSHOT_MATCH } from "./harness/layer-run";
import { R, rasterRig } from "./harness/raster-run";
import { buildRaster, type WireRaster } from "../unit/helpers/raster_fixture";

// Issue 105 (RM1.3): the tile lifecycle on the real layer, in the same harness as 102. Run through /Users/rom/workspace/xdg-pw-lock.sh.
// Software GL (SwiftShader), so every time here is a relative cost. The fixture provider stands in for the pvec-wasm raster
// exports (libviprs/pvec#221), and a "request" is a call to its `tile`, which is what a range request is for the real adapter.
test.use({ launchOptions: launch });
test.setTimeout(240_000);

const MiB = 1024 * 1024;
const evidence: Record<string, unknown> = {};
test.afterAll(() => console.log("EVIDENCE105 " + JSON.stringify(evidence)));

/** Ten 1024 by 512 rasters in a row, 100 source units apart, each about 950 px wide on screen at the harness zoom. */
const ten = (): WireRaster[] =>
  Array.from({ length: 10 }, (_, i) => buildRaster({ id: i, kind: "png", width: 1024, height: 512, edge: 256, pixelToSource: [0.25, 0, 0, -0.25, 100 * i, 100], noImage: true }));

test.describe("issue 105 the tiers of a tile on the real layer", () => {
  test("a 60 second pan across ten rasters under a 16 MiB gpu budget never exceeds it, raises no GL error, leaves no state behind and keeps a frame cheap", async ({ page }) => {
    const r = await rasterRig(page);
    try {
      await R(page, "openRaster", { rasters: ten(), gpuBytes: 16 * MiB, debug: true });
      const p = await R<{ frames: number; maxGpuTier: number; maxDecodedTier: number; glErrors: number; p95Ms: number; p95SteadyMs: number; p95UploadMs: number; p95PrepareMs: number; maxMs: number; stateDiffs: string[]; tileRequests: number; decodes: number }>(page, "pan", { ms: 60_000, vx: 80 });
      const s = await R<{ errors: unknown[]; mainThreadDecodes: number; raster: { levels: number[]; textureBytes: number; decodedBytes: number; encodedBytes: number } }>(page, "stats", undefined);
      expect(p.frames).toBeGreaterThan(300);
      expect(p.maxGpuTier, "the gpu tier, read from the snapshot every frame").toBeLessThanOrEqual(16 * MiB);
      expect(p.maxDecodedTier, "bitmaps waiting for an upload stay under the decoded ceiling").toBeLessThanOrEqual(128 * MiB);
      expect(p.glErrors).toBe(0);
      expect(p.stateDiffs, "no GL state left behind").toEqual([]);
      expect(s.errors).toEqual([]);
      expect(s.mainThreadDecodes, "no decode on the main thread").toBe(0);
      expect(p.decodes, "decodes ran during the pan").toBeGreaterThan(20);
      // The layer's own work per frame (levels, requests, uploads), which is what ADR 0005's 1 ms is about. The whole render call also
      // waits on SwiftShader rasterising, so it is recorded as a relative cost of software GL and not asserted.
      expect(p.p95PrepareMs, "layer CPU per frame with decodes running").toBeLessThan(1);
      evidence.pan = { ...p, endLevels: s.raster?.levels };
    } finally {
      await r.stop();
    }
  });

  test("a forced context loss and restore with the encoded tiles retained makes zero requests and draws the same picture", async ({ page }) => {
    const r = await rasterRig(page);
    try {
      await R(page, "openRaster", { rasters: [buildRaster({ id: 0, kind: "png", width: 1024, height: 512, edge: 256, pixelToSource: [0.25, 0, 0, -0.25, 0, 100] })], debug: false });
      await R(page, "settle", undefined);
      await R(page, "frame", "before");
      const before = (await R<{ tileRequests: number; workerDecodes: number }>(page, "stats", undefined));
      await R(page, "loseAndRestore", undefined);
      await R(page, "settle", undefined);
      await R(page, "frame", "after");
      const after = await R<{ tileRequests: number; workerDecodes: number; errors: unknown[] }>(page, "stats", undefined);
      expect(after.tileRequests, "the request log is empty after the restore").toBe(before.tileRequests);
      expect(after.workerDecodes, "the tiles were decoded again from the retained bytes").toBeGreaterThan(before.workerDecodes);
      const d = await R<{ pixels: number; differing: number }>(page, "compare", ["before", "after"]);
      expect(d.differing / d.pixels).toBeLessThanOrEqual(SNAPSHOT_MATCH);
      expect(after.errors).toEqual([]);
      evidence.contextLoss = { requestsBefore: before.tileRequests, requestsAfter: after.tileRequests, differing: d.differing / d.pixels };
    } finally {
      await r.stop();
    }
  });
});
