import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DISPLAY_FIDELITY_TARGET_PX } from "../../src/config/defaults";
import { MercatorProjectionAdapter } from "../../src/transform/projection";
import { type TransformPipeline, sourceToDevicePx } from "../../src/transform/screen_error";
import { loadEvaluator } from "../../src/wasm/loader";
import { bindPacked } from "../../src/wasm/packed";
import { anchoredGeoRef, camera, transformOf } from "./helpers/scene";
import { EVALUATOR_WASM_BYTES } from "./helpers/probe";

// M2.5: the transform and display pipeline over the real curves. The curves are the canonical pvec artifacts of the corpus, evaluated by
// the pinned pvec-wasm; nothing here evaluates a curve. The pipeline is the add-on's own (calibration, mercator, camera). The evaluator
// is given the affine that best matches that pipeline at the drawing, and the question is whether the polyline it returns is inside
// the budget when measured through the whole pipeline, against a reference tessellation 100 times tighter.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pvec = (id: string): Uint8Array => new Uint8Array(readFileSync(join(root, "tests/fixtures/pvec", `${id}.pvec`)));
const fx = JSON.parse(readFileSync(join(root, "tests/fixtures/projection-amplified-arc/fixture.json"), "utf8")) as {
  camera: { zoom: number; bearing: number; pitch: number; width: number; height: number; devicePixelRatio: number };
  highLatitude: { lng: number; lat: number; anisotropy: number };
  nominal: { lng: number; lat: number; anisotropy: number };
};
const CURVES = ["circle-001", "ellipse-001", "elliptical-arc-001", "bezier-d3-001", "bspline-d3-001", "nurbs-d3-001"];
const WORLD: [number, number, number, number] = [-1e9, -1e9, 1e9, 1e9];
const REFERENCE_FRACTION = 100;

type Site = { lng: number; lat: number; anisotropy: number };
const pipelineAt = (site: Site, dpr: number): TransformPipeline => ({
  transform: transformOf(anchoredGeoRef(site)),
  projection: MercatorProjectionAdapter,
  camera: camera({ ...fx.camera, center: [site.lng, site.lat], devicePixelRatio: dpr }),
});

/** The six numbers of source -> CSS px at the origin of the drawing, by differences of the pipeline itself: `[a, b, c, d, tx, ty]`. */
function linearise(p: TransformPipeline): number[] {
  const css = (x: number, y: number) => sourceToDevicePx(p, x, y).map((v) => v / p.camera.devicePixelRatio) as [number, number];
  const h = 1;
  const o = css(0, 0), px = css(h, 0), py = css(0, h);
  return [(px[0] - o[0]) / h, (py[0] - o[0]) / h, (px[1] - o[1]) / h, (py[1] - o[1]) / h, o[0], o[1]];
}

const IDENTITY = [1, 0, 0, 1, 0, 0];
/** The 15 numbers of the ABI: source_to_map, map_to_screen, pixel ratio, screen budget in device px, world budget. */
const chain = (mapToScreen: number[], dpr: number, screenPx: number): number[] => [...IDENTITY, ...mapToScreen, dpr, screenPx, Infinity];

async function evaluator() {
  return bindPacked(await loadEvaluator({ wasmModule: await WebAssembly.compile(EVALUATOR_WASM_BYTES) }));
}

function polyline(rt: Awaited<ReturnType<typeof evaluator>>, id: string, ch: number[]): number[][] {
  const f = rt.open(pvec(id));
  const b = rt.queryViewport(f, ...WORLD, 100);
  const t = rt.tessellate(b, ch, 5e6, "f64");
  expect(t, `${id}: tessellation refused (${t})`).toBeGreaterThanOrEqual(0);
  const v = rt.views(t);
  const out: number[][] = [];
  for (let i = 0; i < v.entityIds.length; i++) out.push(Array.from(v.vertices.subarray(2 * v.offsets[i]!, 2 * v.offsets[i + 1]!)));
  expect(rt.failed(t)).toBe(0);
  rt.release(t); rt.release(b); rt.release(f);
  return out;
}

const toDevice = (p: TransformPipeline, pts: number[]): number[][] => {
  const o: number[][] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) o.push(sourceToDevicePx(p, pts[i]!, pts[i + 1]!));
  return o;
};
function distToPolyline(q: number[], line: number[][]): number {
  let d = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i] as [number, number], [bx, by] = line[i + 1] as [number, number];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((q[0]! - ax) * dx + (q[1]! - ay) * dy) / l2));
    d = Math.min(d, Math.hypot(q[0]! - (ax + t * dx), q[1]! - (ay + t * dy)));
  }
  return line.length === 1 ? Math.hypot(q[0]! - line[0]![0]!, q[1]! - line[0]![1]!) : d;
}
/** Worst distance, in device px through the pipeline, of the reference polyline from the coarse one. */
function errorPx(p: TransformPipeline, coarse: number[], reference: number[]): number {
  const c = toDevice(p, coarse);
  return Math.max(...toDevice(p, reference).map((q) => distToPolyline(q, c)));
}

describe("M2.5 the real curves through the transform pipeline", () => {
  for (const [name, site] of [["nominal", fx.nominal], ["high latitude on a stretched plan", fx.highLatitude]] as const) {
    for (const dpr of [1, 2]) {
      for (const id of CURVES) {
        it(`${id} at ${name}, device pixel ratio ${dpr}: the polyline is inside the display budget in device px`, async () => {
          const rt = await evaluator();
          const p = pipelineAt(site, dpr);
          const map = linearise(p);
          const [coarse] = polyline(rt, id, chain(map, dpr, DISPLAY_FIDELITY_TARGET_PX));
          const [reference] = polyline(rt, id, chain(map, dpr, DISPLAY_FIDELITY_TARGET_PX / REFERENCE_FRACTION));
          expect(coarse!.length).toBeGreaterThanOrEqual(4);
          expect(reference!.length, "the reference is the tighter one").toBeGreaterThanOrEqual(coarse!.length);
          expect(errorPx(p, coarse!, reference!)).toBeLessThanOrEqual(DISPLAY_FIDELITY_TARGET_PX);
        });
      }
    }
  }

  it("MUTATION asking for the budget in the wrong space (CSS px, device pixel ratio 1) at ratio 3 turns the check red", async () => {
    const rt = await evaluator();
    const p = pipelineAt(fx.highLatitude, 3);
    const map = linearise(p);
    // the pixel ratio dropped from the chain: the evaluator measures in CSS px, three times coarser than the device
    const [coarse] = polyline(rt, "circle-001", chain(map, 1, DISPLAY_FIDELITY_TARGET_PX));
    const [reference] = polyline(rt, "circle-001", chain(map, 3, DISPLAY_FIDELITY_TARGET_PX / REFERENCE_FRACTION));
    expect(errorPx(p, coarse!, reference!)).toBeGreaterThan(DISPLAY_FIDELITY_TARGET_PX);
  });

  it("MUTATION linearising at the nominal site and drawing at the stretched one turns the check red", async () => {
    const rt = await evaluator();
    const p = pipelineAt(fx.highLatitude, 1);
    const wrong = linearise(pipelineAt(fx.nominal, 1));
    const [coarse] = polyline(rt, "circle-001", chain(wrong, 1, DISPLAY_FIDELITY_TARGET_PX));
    const [reference] = polyline(rt, "circle-001", chain(linearise(p), 1, DISPLAY_FIDELITY_TARGET_PX / REFERENCE_FRACTION));
    expect(errorPx(p, coarse!, reference!)).toBeGreaterThan(DISPLAY_FIDELITY_TARGET_PX);
  });
});
