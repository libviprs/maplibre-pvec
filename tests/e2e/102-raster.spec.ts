import { expect, test } from "@playwright/test";
import { launch, SNAPSHOT_MATCH } from "./harness/layer-run";
import { R, rasterRig } from "./harness/raster-run";
import { buildRaster, type Kind, type WireRaster } from "../unit/helpers/raster_fixture";
import type { Mat6 } from "../../src/render/raster/geometry";

// Issue 102 (R2.5): PVec rasters through the real custom layer, on a bare WebGL2 canvas with a map stand-in that projects with
// the real mercator maths. Run via /Users/rom/workspace/xdg-pw-lock.sh. Software GL (SwiftShader), so every timing here is
// labelled as such wherever it is recorded. The fixture provider stands in for the pvec-wasm raster exports (libviprs/pvec#221).
test.use({ launchOptions: launch });

const evidence: Record<string, unknown> = {};
test.afterAll(() => console.log("EVIDENCE102 " + JSON.stringify(evidence)));

// pixel_to_source = s * R(20deg) * [[1, 0.25], [0, 1]] * diag(1, -1) + translation: rotated, sheared and y flipped (d < 0).
function vector(s: number, tx: number, ty: number): Mat6 {
  const c = Math.cos(Math.PI / 9), n = Math.sin(Math.PI / 9), k = 0.25;
  return [s * c, -s * (c * k - n), s * n, -s * (n * k + c), tx, ty];
}
const raster = (id: number, kind: Kind, o: Partial<Parameters<typeof buildRaster>[0]> = {}): WireRaster =>
  buildRaster({ id, kind, width: 384, height: 200, edge: 256, pixelToSource: vector(0.3, 20, 80), ...o });

test.describe("issue 102 rasters in the custom layer", () => {
  test("the rotated, sheared, y flipped vector lands where the placement says, under a stroke, within 0.1 percent of the reference", async ({ page }) => {
    const r = await rasterRig(page);
    try {
      await R(page, "openRaster", { rasters: [raster(0, "png")], stroke: [[40, 150], [200, 130]] });
      await R(page, "settle", undefined);
      await R(page, "frame", "a");
      const d = await R<{ pixels: number; differing: number; covered: number; sample: number[][] }>(page, "diffReference", { name: "a", strokeBand: true });
      console.log("DIFFSAMPLE " + JSON.stringify(d.sample));
      expect(d.covered, "the reference covers a real area").toBeGreaterThan(20000);
      expect(d.differing / d.pixels).toBeLessThanOrEqual(SNAPSHOT_MATCH);
      const s = await R<{ levels: number[]; errors: unknown[] }>(page, "stats", undefined);
      expect(s.errors).toEqual([]);
      expect(s.levels).toEqual([1]);
      evidence.vectorDiff = d.differing / d.pixels;
    } finally {
      await r.stop();
    }
  });

  test("an asymmetric clipped fixture: baked alpha and visible_box, and the padded margin never draws", async ({ page }) => {
    const r = await rasterRig(page);
    try {
      await R(page, "openRaster", { rasters: [raster(0, "png", { visibleBox: [64, 32, 300, 150] })] });
      await R(page, "settle", undefined);
      await R(page, "frame", "a");
      const px = await R<{ magenta: number; drawn: number }>(page, "colourCount", { name: "a", magenta: true });
      expect(px.magenta, "no pixel of the producer's padding").toBe(0);
      expect(px.drawn).toBeGreaterThan(5000);
      const d = await R<{ pixels: number; differing: number }>(page, "diffReference", { name: "a" });
      expect(d.differing / d.pixels).toBeLessThanOrEqual(SNAPSHOT_MATCH);
    } finally {
      await r.stop();
    }
  });

  for (const kind of ["png", "png1", "jpeg"] as const) {
    test(`a ${kind} fixture draws the picture the reference expects`, async ({ page }) => {
      const r = await rasterRig(page);
      try {
        await R(page, "openRaster", { rasters: [raster(0, kind)] });
        await R(page, "settle", undefined);
        await R(page, "frame", "a");
        const d = await R<{ pixels: number; differing: number; covered: number }>(page, "diffReference", { name: "a" });
        expect(d.covered).toBeGreaterThan(20000);
        expect(d.differing / d.pixels).toBeLessThanOrEqual(SNAPSHOT_MATCH);
      } finally {
        await r.stop();
      }
    });
  }

  test("band 0 draws under the same stroke and band 1 over it", async ({ page }) => {
    const r = await rasterRig(page);
    try {
      const at = async (band: 0 | 1) => {
        await R(page, "openRaster", { rasters: [raster(0, "png", { band })], stroke: [[40, 150], [200, 130]] });
        await R(page, "settle", undefined);
        await R(page, "frame", "a");
        return R<number[]>(page, "probePixel", { name: "a", raster: 0, x: 120, y: 140 });
      };
      const under = await at(0), over = await at(1);
      expect(under[0], "the stroke's red over the picture").toBeGreaterThan(170);
      expect(under[1]).toBeLessThan(60);
      expect(over[1], "the picture's green over the stroke").toBeGreaterThan(120);
    } finally {
      await r.stop();
    }
  });

  test("the coarse level draws while the fine tiles are held back, then the fine tiles replace it", async ({ page }) => {
    const r = await rasterRig(page);
    try {
      await R(page, "openRaster", { rasters: [raster(0, "png")], hold: { fromLevel: 1 } });
      await R(page, "settle", undefined);
      await R(page, "frame", "coarse");
      const coarse = await R<{ levels: number[]; held: number }>(page, "stats", undefined);
      expect(coarse.levels, "the coarse level is on screen").toEqual([0]);
      expect(coarse.held).toBeGreaterThan(0);
      const covered = await R<{ drawn: number }>(page, "colourCount", { name: "coarse", magenta: false });
      expect(covered.drawn).toBeGreaterThan(5000);
      await R(page, "release", undefined);
      await R(page, "settle", undefined);
      await R(page, "frame", "fine");
      expect((await R<{ levels: number[] }>(page, "stats", undefined)).levels).toEqual([1]);
      const d = await R<{ pixels: number; differing: number }>(page, "diffReference", { name: "fine" });
      expect(d.differing / d.pixels).toBeLessThanOrEqual(SNAPSHOT_MATCH);
    } finally {
      await r.stop();
    }
  });

  test("no image is decoded on the main thread, textures stay in the gpu tier's accounting, and a frame stays under 1 ms", async ({ page }) => {
    const r = await rasterRig(page);
    try {
      await R(page, "openRaster", { rasters: [raster(0, "png"), raster(1, "jpeg", { pixelToSource: vector(0.3, 70, 20) }), raster(2, "png1", { pixelToSource: vector(0.3, 20, 20) })] });
      await R(page, "settle", undefined);
      const s = await R<{ mainThreadDecodes: number; workerDecodes: number; gpuTierBytes: number; textures: number; tileBytes: number; decodeMs: Record<string, number[]>; uploadsPerFrame: number[]; renderMs: number[] }>(page, "stats", undefined);
      expect(s.mainThreadDecodes).toBe(0);
      expect(s.workerDecodes).toBeGreaterThan(0);
      expect(s.gpuTierBytes, "the cache accounts for every texture the renderer holds").toBe(s.textures * s.tileBytes);
      await R(page, "steadyFrames", 30);
      const t = await R<{ renderMs: number[] }>(page, "stats", undefined);
      const sorted = [...t.renderMs].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
      expect(p95, "main-thread cost of a steady frame (software GL)").toBeLessThan(1);
      evidence.decodeMsPerTile = s.decodeMs;
      evidence.uploadsPerFrame = s.uploadsPerFrame;
      evidence.textureBytesPerTile = s.tileBytes;
      evidence.steadyFrameP95Ms = p95;
      evidence.renderer = "software GL (SwiftShader), not a GPU";
    } finally {
      await r.stop();
    }
  });

  test("the state guard keeps its shadow: no synchronous GL read in a frame with rasters, and no state left behind", async ({ page }) => {
    const r = await rasterRig(page);
    try {
      await R(page, "openRaster", { rasters: [raster(0, "png")], stroke: [[40, 150], [200, 130]], debug: true });
      await R(page, "settle", undefined);
      await R(page, "steadyFrames", 5);
      expect((await R<{ stateDiffs: string[] }>(page, "stats", undefined)).stateDiffs).toEqual([]);
      await R(page, "openRaster", { rasters: [raster(0, "png")], stroke: [[40, 150], [200, 130]], debug: false });
      await R(page, "settle", undefined);
      const c = await R<{ getParameter: number; isEnabled: number; cullFaceEnabled: number }>(page, "countReads", 10);
      expect(c.getParameter).toBe(0);
      expect(c.isEnabled).toBe(0);
      expect(c.cullFaceEnabled, "no winding cull: CULL_FACE is never switched on").toBe(0);
    } finally {
      await r.stop();
    }
  });

  test("an unknown codec is skipped and reported, a file without a raster renders exactly as before, and a module without the exports draws as before", async ({ page }) => {
    const r = await rasterRig(page);
    try {
      const odd = raster(1, "png");
      odd.placement.codec = 9;
      await R(page, "openRaster", { rasters: [raster(0, "png"), odd] });
      await R(page, "settle", undefined);
      const s = await R<{ events: unknown[]; skips: { rasterId: number; rule: string; message: string }[]; levels: number[]; errors: unknown[] }>(page, "stats", undefined);
      expect(s.events).toEqual([]);
      expect(s.skips).toEqual([expect.objectContaining({ rasterId: 1, rule: "RASTER-04" })]);
      expect(s.levels).toEqual([1]);
      expect(s.errors).toEqual([]);

      await R(page, "openRaster", { rasters: [], stroke: [[40, 150], [200, 130]] });
      await R(page, "frame", "empty");
      await R(page, "openRaster", { rasters: null, stroke: [[40, 150], [200, 130]] });
      await R(page, "frame", "absent");
      const same = await R<{ pixels: number; differing: number }>(page, "compare", ["empty", "absent"]);
      expect(same.differing).toBe(0);
      const after = await R<{ events: unknown[]; skips: unknown[]; errors: unknown[] }>(page, "stats", undefined);
      expect(after.events).toEqual([]);
      expect(after.skips).toEqual([]);
    } finally {
      await r.stop();
    }
  });

  test("#104 update({ raster: { enabled: false } }) draws no raster and starts no decode, and true draws it again from the cache", async ({ page }) => {
    const r = await rasterRig(page);
    try {
      await R(page, "openRaster", { rasters: [raster(0, "png")], stroke: [[40, 150], [200, 130]] });
      await R(page, "settle", undefined);
      await R(page, "frame", "on");
      const decodes = (await R<{ workerDecodes: number }>(page, "stats", undefined)).workerDecodes;
      await R(page, "setRaster", false);
      await R(page, "frame", "off");
      await R(page, "setRaster", true);
      await R(page, "frame", "back");
      const same = await R<{ pixels: number; differing: number }>(page, "compare", ["on", "back"]);
      expect(same.differing, "switching back on restores the picture").toBe(0);
      const gone = await R<{ pixels: number; differing: number }>(page, "compare", ["on", "off"]);
      expect(gone.differing, "off draws something else").toBeGreaterThan(5000);
      expect((await R<{ workerDecodes: number }>(page, "stats", undefined)).workerDecodes, "the switch decodes nothing").toBe(decodes);
    } finally {
      await r.stop();
    }
  });

  test("a gpu tier too small for the view draws a coarser level and stays within it", async ({ page }) => {
    const r = await rasterRig(page);
    try {
      await R(page, "openRaster", { rasters: [raster(0, "png")], gpuBytes: 3 * 256 * 256 * 4 });
      await R(page, "settle", undefined);
      await R(page, "frame", "a");
      const s = await R<{ levels: number[]; gpuTierBytes: number }>(page, "stats", undefined);
      expect(s.levels).toEqual([0]);
      expect(s.gpuTierBytes).toBeLessThanOrEqual(3 * 256 * 256 * 4);
    } finally {
      await r.stop();
    }
  });
});
