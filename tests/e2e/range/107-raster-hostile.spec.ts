import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { launch, SNAPSHOT_MATCH } from "../harness/layer-run";
import { R, rasterRig } from "../harness/raster-run";
import { composeRig, C } from "../harness/compose-run";
import { buildRaster, type WireRaster } from "../../unit/helpers/raster_fixture";

// Issue 107 (RM1.5): what the layer does with tiles it cannot show. Chromium, software GL, through the lock. The refusals here come
// from the fixture provider, which throws the way the pvec-wasm adapter will when the module refuses a tile by a rule: that checks
// the layer's side (one report, no exception, the strokes still draw). pvec's own sniffers are held to the same thirteen tiles in
// libviprs/pvec (issue_219_hostile_tiles.rs); running them from this repository needs the adapter, see docs/deferred.md.
test.use({ launchOptions: launch });
test.setTimeout(180_000);

const evidence: Record<string, unknown> = {};
test.afterAll(() => console.log("EVIDENCE107 " + JSON.stringify(evidence)));

// pvec's hostile corpus (crates/pvec-testkit/src/raster_hostile.rs): the name and the rule that refuses it.
const HOSTILE: [string, string][] = [
  ["oversized-tile", "LIMIT-15"],
  ["polyglot-png-and-zip", "RASTER-03"],
  ["animated-webp", "RASTER-03"],
  ["interlaced-png", "RASTER-03"],
  ["sixteen-bit-png", "RASTER-03"],
  ["palette-png", "RASTER-03"],
  ["jpeg-with-four-components", "RASTER-03"],
  ["jpeg-frame-header-past-64-kib", "RASTER-03"],
  ["header-lies-about-the-size", "RASTER-03"],
  ["bit-depth-mismatch", "RASTER-03"],
  ["raw-tile", "RASTER-04"],
  ["jpeg-under-an-rgba-placement", "RASTER-04"],
  ["tile-at-limit-15-plus-one", "LIMIT-15"],
];

const good = (id: number) => buildRaster({ id, kind: "png", width: 384, height: 200, edge: 256, pixelToSource: [0.3, 0, 0, -0.3, 20, 80] });

test.describe("issue 107 hostile tiles on the host side", () => {
  test("every refused tile is one rasterskipped with its rule and no exception, the strokes still draw, and the frame equals its raster-free twin", async ({ page }) => {
    const r = await rasterRig(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    try {
      const refuse: Record<number, string> = {};
      const rasters: WireRaster[] = [good(0)];
      HOSTILE.forEach(([, rule], i) => {
        refuse[i + 1] = rule;
        rasters.push(buildRaster({ id: i + 1, kind: "png", width: 256, height: 256, edge: 256, pixelToSource: [0.3, 0, 0, -0.3, 20 + 2 * i, 80], noImage: true }));
      });
      await R(page, "openRaster", { rasters, refuse, stroke: [[40, 150], [200, 130]] });
      await R(page, "settle", undefined);
      await R(page, "frame", "hostile");
      const s = await R<{ skips: { rasterId: number; rule: string }[]; errors: unknown[]; events: unknown[]; levels: number[] }>(page, "stats", undefined);
      expect([...s.skips].sort((a, b) => a.rasterId - b.rasterId).map((x) => [x.rasterId, x.rule])).toEqual(HOSTILE.map(([, rule], i) => [i + 1, rule]));
      expect(new Set(s.skips.map((x) => x.rasterId)).size, "exactly one report per refused raster").toBe(13);
      expect(s.errors).toEqual([]);
      expect(s.events).toEqual([]);
      expect(pageErrors).toEqual([]);
      expect(s.levels.length, "the good raster draws").toBeGreaterThan(0);

      await R(page, "openRaster", { rasters: [good(0)], stroke: [[40, 150], [200, 130]] });
      await R(page, "settle", undefined);
      await R(page, "frame", "twin");
      const d = await R<{ pixels: number; differing: number }>(page, "compare", ["hostile", "twin"]);
      expect(d.differing / d.pixels, "the hostile file draws what its raster-free twin draws").toBeLessThanOrEqual(SNAPSHOT_MATCH);
      evidence.refusals = { reported: s.skips.length, twinDiff: d.differing / d.pixels };
    } finally {
      await r.stop();
    }
  });

  test("a valid header over a corrupt body is a missing tile: counted, retried a bounded number of times, never in a loop, no exception", async ({ page }) => {
    const r = await rasterRig(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    try {
      await R(page, "openRaster", { rasters: [good(0), good(1)], corrupt: [1], stroke: [[40, 150], [200, 130]] });
      // frames until every retry wait has run out (30 + 60 frames)
      for (let i = 0; i < 6; i++) await R(page, "runFrames", 60);
      const a = await R<{ tileRequests: number; raster: { failedTiles: number; decodeFailures: number }; errors: { code: string }[]; workerDecodes: number }>(page, "stats", undefined);
      expect(a.raster.failedTiles, "the corrupt raster's tiles are counted as missing").toBeGreaterThan(0);
      expect(a.raster.decodeFailures).toBeLessThanOrEqual(3 * a.raster.failedTiles);
      expect(a.raster.decodeFailures, "and were retried").toBeGreaterThan(a.raster.failedTiles);
      await R(page, "runFrames", 240);
      const b = await R<{ tileRequests: number; raster: { decodeFailures: number }; errors: unknown[] }>(page, "stats", undefined);
      expect(b.raster.decodeFailures, "not another attempt once the bound is reached").toBe(a.raster.decodeFailures);
      expect(b.tileRequests, "the retained bytes were decoded again, nothing was fetched again").toBe(a.tileRequests);
      expect(pageErrors).toEqual([]);
      await R(page, "frame", "corrupt");
      expect((await R<{ levels: number[] }>(page, "stats", undefined)).levels.length, "the intact raster draws").toBeGreaterThan(0);
      evidence.corrupt = { failedTiles: a.raster.failedTiles, decodeFailures: a.raster.decodeFailures };
    } finally {
      await r.stop();
    }
  });

  test("a decode time bomb (a 1024 px progressive JPEG, the largest tile) decodes off the main thread and the layer's frame stays under 1 ms", async ({ page }) => {
    const r = await rasterRig(page);
    try {
      const jpeg = readFileSync("tests/fixtures/raster/jpeg-1024-progressive.jpg");
      const wire: WireRaster = {
        placement: { id: 0, pixelToSource: [0.13, 0, 0, -0.13, 9, 114], width: 1024, height: 1024, visibleBox: [0, 0, 1024, 1024], tileEdge: 1024, levels: 1, codec: 2, channels: 3, bitDepth: 8, opacity: 255, band: 0 },
        tiles: { "0/0/0": jpeg.toString("base64") },
        image: "",
      };
      await R(page, "openRaster", { rasters: [wire], debug: false });
      const f = await R<{ layerMs: number[]; decodesBefore: number; decodesAfter: number }>(page, "runFrames", 90);
      const s = await R<{ mainThreadDecodes: number; workerDecodes: number; decodeMs: Record<string, number[]>; errors: unknown[]; raster: { textures: number } }>(page, "stats", undefined);
      expect(s.errors).toEqual([]);
      expect(s.workerDecodes, "decoded in a worker").toBe(1);
      expect(s.mainThreadDecodes, "never on the main thread").toBe(0);
      expect(s.raster.textures).toBe(1);
      const sorted = [...f.layerMs].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      expect(p95, "the layer's own time per frame while the tile decodes (software GL, relative)").toBeLessThan(1);
      evidence.bomb = { bytes: jpeg.length, decodeMs: Object.values(s.decodeMs).flat(), layerP95Ms: p95, frames: f.layerMs.length };
    } finally {
      await r.stop();
    }
  });

  test("a placement whose full level LIMIT-16 cannot hold is drawn from the level it allows, and the host never holds more than maxDecodedBytes", async ({ page }) => {
    const r = await rasterRig(page);
    try {
      const cap = 4 * 256 * 256 * 4;
      const w = buildRaster({ id: 0, kind: "png", width: 1024, height: 1024, edge: 256, pixelToSource: [0.13, 0, 0, -0.13, 9, 114], noImage: true });
      await R(page, "openRaster", { rasters: [w], maxDecodedBytes: cap, debug: false });
      const f = await R<{ maxDecodedTier: number }>(page, "runFrames", 120);
      await R(page, "settle", undefined);
      const s = await R<{ raster: { levels: number[]; decodedBytes: number }; errors: unknown[] }>(page, "stats", undefined);
      expect(s.errors).toEqual([]);
      expect(f.maxDecodedTier, "bitmaps held").toBeLessThanOrEqual(cap);
      expect(s.raster.levels, "level 2 (16 tiles) would not fit, level 1 (4 tiles) does").toEqual([1]);
      evidence.limit16 = { cap, maxDecodedTier: f.maxDecodedTier, levels: s.raster.levels };
    } finally {
      await r.stop();
    }
  });
});

test.describe("issue 107 attribution is text in a real attribution control", () => {
  test("markup in an attribution renders as text, and no element comes of it", async ({ page }) => {
    const r = await composeRig(page);
    try {
      const k = (160 * 360) / (512 * 512 * 4);
      const cal = { k, lng0: 20 - 256 * k, lat0: 20 - 256 * k };
      const evil = `<img src=x onerror="document.title='pwned'"> & "Survey" <script>alert(1)</script>`;
      const w = buildRaster({ id: 0, kind: "png", width: 512, height: 512, edge: 256, pixelToSource: [1, 0, 0, -1, 0, 512], solid: [0, 200, 200, 255], noImage: true });
      w.placement.attribution = evil;
      await C(page, "open", { v: "v4", rasters: [w], calibration: cal, center: [20, 20], zoom: 2 });
      const out = await C<{ text: string; html: string; imgs: number; scripts: number; title: string }>(page, "attributionControl");
      expect(out.text, "the markup is on screen as text").toContain(`<img src=x onerror="document.title='pwned'">`);
      expect(out.text).toContain("<script>alert(1)</script>");
      expect(out.imgs, "no element came of it").toBe(0);
      expect(out.scripts).toBe(0);
      expect(out.title).not.toBe("pwned");
    } finally {
      await r.stop();
    }
  });
});
