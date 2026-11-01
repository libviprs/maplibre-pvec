import { expect, test } from "@playwright/test";
import { launch, SNAPSHOT_MATCH } from "../harness/layer-run";
import { C, composeRig } from "../harness/compose-run";
import { buildRaster } from "../../unit/helpers/raster_fixture";

// Issue 106 (RM1.4): the quads on a real MapLibre map among the host's own layers, on 4.7.1, 5.24.0 and 6.16.0. Run through
// /Users/rom/workspace/xdg-pw-lock.sh, one at a time. Software GL (SwiftShader): the numbers say nothing about a GPU. The fixture
// provider stands in for the pvec-wasm raster exports. The grid of #107 runs this spec on the other engines.
test.use({ launchOptions: launch });
test.setTimeout(300_000);

const VERSIONS = ["v4", "v5", "v6"] as const;
const CENTER: [number, number] = [20, 20];
const SCAN = [0, 200, 200, 255];
const BASEMAP = [30, 160, 60, 255];
const ICON = [0, 0, 200, 255];
const evidence: Record<string, unknown> = {};
test.afterAll(() => console.log("EVIDENCE106 " + JSON.stringify(evidence)));

/** 512 by 512 px, one source unit a pixel, y flipped (an upright image has d < 0), centred in source space on (256, 256). */
const scan = (o: { opacity?: number; band?: 0 | 1; hole?: [number, number, number, number] } = {}) =>
  buildRaster({ id: 0, kind: "png", width: 512, height: 512, edge: 256, pixelToSource: [1, 0, 0, -1, 0, 512], solid: SCAN as [number, number, number, number], noImage: true, ...o });
const cal = (zoom: number) => {
  const k = (160 * 360) / (512 * 512 * 2 ** zoom);
  return { k, lng0: CENTER[0] - 256 * k, lat0: CENTER[1] - 256 * k };
};

for (const v of VERSIONS) {
  test.describe(`106 compose on MapLibre ${v}`, () => {
    test("symbols above band 1 stay readable, a MapLibre raster below shows through baked alpha and under the scan, beforeId moves the layer, no stencil write", async ({ page }) => {
      const r = await composeRig(page);
      try {
        const base = { v, calibration: cal(2), center: CENTER, zoom: 2, symbols: true, basemap: true } as const;
        await C(page, "open", { ...base, rasters: [] });
        await C(page, "snap", "symbolsOnly");
        expect(await C<number>(page, "countColour", { name: "symbolsOnly", colour: ICON }), "the icons draw without the layer").toBeGreaterThan(300);

        // band 1, opaque, with the layer placed below the symbol layer
        await C(page, "open", { ...base, rasters: [scan({ band: 1 })], beforeId: "symbols" });
        await C(page, "snap", "band1");
        const labels = await C<{ pixels: number; differing: number; masked: number }>(page, "compare", { a: "band1", b: "symbolsOnly", onlyWhereIcon: "symbolsOnly" });
        expect(labels.masked).toBeGreaterThan(300);
        expect(labels.differing / labels.pixels, "icon pixels are the symbol layer's own").toBeLessThanOrEqual(SNAPSHOT_MATCH);
        expect(await C<number>(page, "countColour", { name: "band1", colour: SCAN }), "the scan is drawn").toBeGreaterThan(10000);
        const info = await C<{ errors: string[]; stateDiffs: string[]; spy: { draws: number; badBlend: number; stencilDraws: number } }>(page, "info");
        expect(info.errors).toEqual([]);
        expect(info.stateDiffs, "the guard's debug diff after every frame").toEqual([]);
        expect(info.spy.draws).toBeGreaterThan(0);
        expect(info.spy.stencilDraws, "the layer draws with the stencil test off").toBe(0);
        expect(info.spy.badBlend, "every draw blends ONE, ONE_MINUS_SRC_ALPHA").toBe(0);

        // band 0 with baked alpha over a MapLibre raster source: opaque scan covers it, the hole shows it
        await C(page, "open", { ...base, rasters: [scan({ band: 0, hole: [0, 0, 128, 128] })], beforeId: "symbols" });
        await C(page, "snap", "holed");
        const d = 160 / 512;
        // device px of the raster's pixel (x, y) at the map centre, bearing 0: the centre of the canvas is the raster centre
        const at = (px: number, py: number) => ({ x: 160 + (px - 256) * d, y: 160 + (py - 256) * d });
        const solid = at(400, 400), hole = at(40, 40);
        expect(await C<number[]>(page, "probe", { name: "holed", ...solid }), "opaque scan hides the MapLibre raster").toEqual(SCAN);
        expect(await C<number[]>(page, "probe", { name: "holed", ...hole }), "baked alpha shows the MapLibre raster").toEqual(BASEMAP);

        // opacity multiplies into the premultiplied fragment
        await C(page, "open", { ...base, rasters: [scan({ band: 0, opacity: 128 })], beforeId: "symbols" });
        await C(page, "snap", "half");
        const half = await C<number[]>(page, "probe", { name: "half", ...solid });
        for (let k = 0; k < 3; k++) expect(Math.abs(half[k]! - (SCAN[k]! * 128 + BASEMAP[k]! * 127) / 255), `channel ${k} of ${half}`).toBeLessThanOrEqual(3);

        // beforeId is the only ordering knob
        await C(page, "open", { ...base, rasters: [scan({ band: 1 })] });
        await C(page, "snap", "top");
        expect(await C<number>(page, "countColour", { name: "top", colour: ICON }), "on top the scan covers the icons").toBe(0);
        await C(page, "open", { ...base, rasters: [scan({ band: 1 })], beforeId: "basemap" });
        await C(page, "snap", "bottom");
        expect(await C<number>(page, "countColour", { name: "bottom", colour: SCAN }), "below the MapLibre raster the scan is hidden").toBe(0);
        expect(await C<number>(page, "countColour", { name: "bottom", colour: ICON }), "the icons still draw").toBeGreaterThan(300);
        evidence[`compose${v}`] = { iconDiff: labels.differing / labels.pixels };
      } finally {
        await r.stop();
      }
    });

    test("the scan edge and a stroke along it coincide within one device pixel at zooms 0 to 4, bearings 0 and 30, pixel ratios 1 and 2", async ({ page }) => {
      const r = await composeRig(page);
      try {
        const rows: Record<string, number> = {};
        let worst = 0;
        for (const ratio of [1, 2]) {
          // the stroke runs along the middle two fifths of the left edge, x = 0 in source space, so the edge itself shows above and below it
          const strokes = [[0, 0.3 * 512, 0, 0.7 * 512]];
          await C(page, "open", { v, ratio, rasters: [scan({ band: 0 })], strokes, calibration: cal(0), center: CENTER, zoom: 0 });
          for (const zoom of [0, 1, 2, 3, 4]) {
            for (const bearing of [0, 30]) {
              await C(page, "setView", { zoom, bearing, center: CENTER, calibration: cal(zoom) });
              await C(page, "settle");
              const a = await C<{ distancePx: number; strokeRows: number; edgeRows: number }>(page, "alignment", `a${zoom}_${bearing}_${ratio}`);
              rows[`z${zoom} b${bearing} x${ratio}`] = Math.round(a.distancePx * 1000) / 1000;
              expect(a.strokeRows, `z${zoom} bearing ${bearing} ratio ${ratio}: the stroke is in the frame`).toBeGreaterThan(5);
              expect(a.edgeRows, `z${zoom} bearing ${bearing} ratio ${ratio}: the scan edge is in the frame`).toBeGreaterThan(5);
              expect(a.distancePx, `z${zoom} bearing ${bearing} ratio ${ratio}`).toBeLessThanOrEqual(1);
              worst = Math.max(worst, a.distancePx);
            }
          }
        }
        const info = await C<{ errors: string[]; stateDiffs: string[] }>(page, "info");
        expect(info.errors).toEqual([]);
        expect(info.stateDiffs).toEqual([]);
        evidence[`alignment${v}`] = { worstDevicePx: worst, rows };
      } finally {
        await r.stop();
      }
    });

    test("1,000 georeference updates issue zero range requests, keep the textures, and the scan follows the stroke", async ({ page }) => {
      const r = await composeRig(page);
      try {
        const strokes = [[0, 0.3 * 512, 0, 0.7 * 512]];
        const a = cal(2), b = { ...a, lng0: a.lng0 + 6 * a.k, lat0: a.lat0 + 4 * a.k };
        await C(page, "open", { v, rasters: [scan({ band: 0 })], strokes, calibration: a, center: CENTER, zoom: 2 });
        const gets = r.gets();
        const before = await C<{ tileRequests: number }>(page, "info");
        const u = await C<{ ms: number; tileRequests: number }>(page, "hotUpdates", { n: 1000, a, b });
        expect(u.tileRequests, "zero tile requests across 1,000 updates").toBe(before.tileRequests);
        expect(r.gets(), "zero range requests to the origin").toBe(gets);
        const al = await C<{ distancePx: number; strokeRows: number; edgeRows: number }>(page, "alignment", "afterHot");
        expect(al.strokeRows).toBeGreaterThan(5);
        expect(al.distancePx, "the raster followed the strokes").toBeLessThanOrEqual(1);
        const info = await C<{ errors: string[]; stateDiffs: string[] }>(page, "info");
        expect(info.errors).toEqual([]);
        expect(info.stateDiffs).toEqual([]);
        evidence[`hot${v}`] = { updates: 1000, ms: u.ms, distancePx: al.distancePx, tileRequests: u.tileRequests - before.tileRequests };
      } finally {
        await r.stop();
      }
    });

    test("the corner landing error against map.project at pitch 0, 30 and 60 is recorded, and exact at pitch 0", async ({ page }) => {
      const r = await composeRig(page);
      try {
        const out: Record<string, { corners: number[]; maxPx: number }> = {};
        await C(page, "open", { v, rasters: [scan({ band: 0 })], calibration: cal(2), center: CENTER, zoom: 2 });
        for (const pitch of [0, 30, 60]) {
          await C(page, "setView", { zoom: 2, bearing: 0, center: CENTER, pitch });
          out[`pitch${pitch}`] = await C(page, "cornerError");
        }
        expect(out.pitch0!.maxPx, "at pitch 0 the chain lands every corner on the projection").toBeLessThan(0.5);
        evidence[`pitch${v}`] = out;
      } finally {
        await r.stop();
      }
    });
  });
}
