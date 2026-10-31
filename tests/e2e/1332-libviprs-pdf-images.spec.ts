import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { RangeOrigin } from "../unit/helpers/origin";
import { launch } from "./harness/layer-run";
import { R, rasterRig } from "./harness/raster-run";

// libviprs/libviprs#1332 (RL2.1): the interop check. A PDF with a scanned underlay, converted by libviprs (pvec::pdf_image,
// the writer in tests/pvec_1332_interop_fixture.rs there) into a .pvec, goes through the real pvec-wasm module and the real layer,
// and the raster draws under the linework. Chromium, software GL (SwiftShader), through the lock. The linework is the PDF's own
// stroke (the file holds it as an entity too), fed to the layer's stroke pipeline in source space by the harness.
//
// The scan is a 64 by 48 ramp, 40 + 3 * x, painted 100 by 75 at source (25, 10); the stroke runs corner to corner.
test.use({ launchOptions: launch });

const dir = "tests/fixtures/pvec-raster/libviprs";
const wasm = readFileSync("wasm/pvec_eval.wasm").toString("base64");
const STROKE = [25, 10, 125, 85];
const RED = [0xcc, 0, 0];

async function snapshot(page: import("@playwright/test").Page, file: string, stroke?: number[], centre?: [number, number]) {
  const origin = new RangeOrigin(new Uint8Array(readFileSync(`${dir}/${file}`)));
  const base = await origin.start();
  const r = await rasterRig(page);
  try {
    await R(page, "openRaster", { rasters: [], real: { url: `${base}/p.pvec`, wasm, ...(stroke ? { stroke } : {}) }, debug: false });
    if (centre) await R(page, "centreOn", { x: centre[0], y: centre[1] });
    await R(page, "settle", undefined);
    await R(page, "frame", "a");
    const at = (x: number, y: number) => R<number[]>(page, "probeSource", { name: "a", x, y });
    const s = await R<{ skips: unknown[]; errors: unknown[]; decodePosts: number; mainThreadDecodes: number; raster?: { levels: number[] } }>(page, "stats", undefined);
    return { at, s, centre: await at(75, 47.5), left: await at(45, 70), right: await at(105, 20), off: await at(10, 150) };
  } finally {
    await r.stop();
    await origin.stop();
  }
}

const near = (got: number[], want: number[], slack: number) => got.slice(0, want.length).every((v, i) => Math.abs(v - want[i]!) <= slack);
// image x = (X - 25) / 100 * 64, so the ramp at source X is 40 + 3 * (0.64 * (X - 25) - 0.5)
const ramp = (X: number) => 40 + 3 * (0.64 * (X - 25) - 0.5);

test.describe("libviprs#1332 a PDF scan converted by libviprs, through the real module and layer", () => {
  test("the scan is band 0: it draws where the placement says and the linework is on top of it", async ({ page }) => {
    const errs: string[] = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    const o = await snapshot(page, "scan_under_linework.pvec", STROKE);
    expect(errs).toEqual([]);
    expect(o.s.errors).toEqual([]);
    expect(o.s.skips).toEqual([]);
    expect(o.s.decodePosts, "its tiles reached the worker").toBeGreaterThan(0);
    expect(o.s.mainThreadDecodes).toBe(0);
    expect(o.s.raster!.levels.length, "and drew").toBeGreaterThan(0);
    expect(near(o.left, [ramp(45), ramp(45), ramp(45)], 8), `left ${o.left} want ${ramp(45)}`).toBe(true);
    expect(near(o.right, [ramp(105), ramp(105), ramp(105)], 8), `right ${o.right} want ${ramp(105)}`).toBe(true);
    expect(near(o.off, [223, 231, 238], 3), `outside the sheet ${o.off} is the background`).toBe(true);
    expect(near(o.centre, RED, 12), `under the stroke ${o.centre}: the linework covers the scan`).toBe(true);
  });

  test("the same scan painted after the stroke is band 1: the raster covers the linework", async ({ page }) => {
    const o = await snapshot(page, "scan_over_linework.pvec", STROKE);
    expect(o.s.errors).toEqual([]);
    expect(o.s.skips).toEqual([]);
    expect(near(o.centre, [ramp(75), ramp(75), ramp(75)], 8), `centre ${o.centre}: the scan is over the stroke`).toBe(true);
    expect(near(o.left, [ramp(45), ramp(45), ramp(45)], 8)).toBe(true);
  });

  test("the committed three-image fixture of libviprs-tests converts to three rasters and the first draws where its CTM puts it", async ({ page }) => {
    // The page's first image is painted 100 by 100 at page (50, 600), which is source (75, 610) after the shift of the writer.
    const o = await snapshot(page, "three_images.pvec", undefined, [125, 660]);
    expect(near(await o.at(125, 660), [223, 231, 238], 3), "the first image covers the camera centre").toBe(false);
    expect(o.s.errors).toEqual([]);
    expect(o.s.skips).toEqual([]);
    expect(o.s.decodePosts).toBeGreaterThan(0);
    expect(o.s.mainThreadDecodes).toBe(0);
  });
});
