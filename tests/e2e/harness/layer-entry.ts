import maplibregl from "maplibre-gl";
import { createPVecLayer, type PVecLayer } from "../../../src/index";
import { configureEngine } from "../../../src/layer/internal";
import { loadEvaluator } from "../../../src/wasm/loader";
import { Epsg4326Adapter } from "../../../src/transform/crs";
import { createGeoTransform } from "../../../src/transform/georeference";
import type { RawEntity } from "../../../src/decode/tier0";

// Stand-in cursor and evaluator: the real ones come with libviprs/pvec (issue 80). Everything else, the
// layer, the pool, the stroke renderer and the state guard, is the real code on a real map.
const CENTER: [number, number] = [8.54, 47.37];
const reference = {
  kind: "affine" as const,
  unit: "m" as const,
  crs: Epsg4326Adapter,
  calibration: [1e-5, 0, 0, 1e-5, CENTER[0] - 0.0005, CENTER[1] - 0.0005] as const,
};
const LINES: number[][] = [
  [10, 10, 90, 10, 90, 50],
  [10, 90, 90, 60],
  [20, 30, 20, 70],
];
const WIDTH = 4;

export interface OpenOptions {
  fixture: string;
  layer: boolean;
  cursor: boolean;
  wasm: "ok" | "blocked";
  debugState?: boolean;
}
interface Snap { w: number; h: number; data: Uint8ClampedArray }

const state = {
  map: undefined as maplibregl.Map | undefined,
  layer: undefined as PVecLayer | undefined,
  errors: [] as { code: string; message: string }[],
  mapErrors: 0,
  stateDiffs: [] as string[],
  frames: 0,
  snaps: {} as Record<string, Snap>,
};

function entities(): RawEntity[] {
  return LINES.map((points, i) => ({
    entityId: `e${i}`,
    kind: "exact" as const,
    geometry: { type: "polyline" as const, points },
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  }));
}

const idle = (map: maplibregl.Map) => new Promise<void>((r) => (map.triggerRepaint(), map.once("idle", () => r())));

export async function open(o: OpenOptions): Promise<void> {
  state.map?.remove();
  document.body.replaceChildren();
  state.layer = undefined;
  state.errors = [];
  state.mapErrors = 0;
  state.stateDiffs = [];
  state.frames = 0;
  const host = document.createElement("div");
  host.style.cssText = "width:320px;height:320px;position:absolute;left:0;top:0";
  document.body.appendChild(host);
  const fc = (type: string, coordinates: unknown) => ({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type, coordinates } }] });
  const [x, y] = CENTER;
  const map = (state.map = new maplibregl.Map({
    container: host,
    center: CENTER,
    zoom: 17,
    interactive: false,
    fadeDuration: 0,
    attributionControl: false,
    preserveDrawingBuffer: true,
    style: {
      version: 8,
      sources: {
        area: { type: "geojson", data: fc("Polygon", [[[x - 0.0006, y - 0.0003], [x + 0.0002, y - 0.0003], [x + 0.0002, y + 0.0004], [x - 0.0006, y + 0.0004], [x - 0.0006, y - 0.0003]]]) as never },
        road: { type: "geojson", data: fc("LineString", [[x - 0.001, y + 0.0002], [x + 0.001, y - 0.0002]]) as never },
        pts: { type: "geojson", data: fc("MultiPoint", [[x - 0.0004, y + 0.0003], [x, y], [x + 0.0004, y - 0.0003], [x + 0.0003, y + 0.0004]]) as never },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#dfe7ee" } },
        { id: "area", type: "fill", source: "area", paint: { "fill-color": "#88aa66", "fill-opacity": 0.8 } },
        { id: "road", type: "line", source: "road", paint: { "line-color": "#223344", "line-width": 6 } },
      ],
    },
  }));
  map.on("error", () => state.mapErrors++);
  await new Promise<void>((r) => map.once("load", () => r()));

  if (o.layer) {
    const layer = (state.layer = createPVecLayer({ id: "pvec", source: { url: o.fixture }, georeference: { reference } }));
    layer.on("error", (e) => state.errors.push({ code: e.code, message: e.message }));
    const loader =
      o.wasm === "ok"
        ? () => Promise.resolve({ instance: {} as WebAssembly.Instance, abiVersion: 1, source: "injected" as const })
        : () => loadEvaluator({ wasmUrl: new URL("/83-missing.wasm", location.href).href });
    let served = !o.cursor;
    configureEngine(layer, {
      loadEvaluator: loader,
      maplibreVersion: () => maplibregl.getVersion(),
      openCursor: async () => (o.cursor ? { next: () => (served ? null : ((served = true), entities())) } : null),
      ...(o.debugState ? { onStateDiff: (d: string[]) => void (state.stateDiffs.push(...d), state.frames++) } : {}),
    });
    layer.registerComponent("style", { resolve: () => ({ widthPx: WIDTH, dash: [], color: "#cc0000" }) });
    map.addLayer(layer as never);
    await layer.whenReady();
  }

  // The symbol layer goes on after ours, so a stencil or state leak from the add-on would show on its icons.
  const icon = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 256; i++) icon.set([0, 0, 200, 255], i * 4);
  map.addImage("dot", { width: 16, height: 16, data: icon });
  map.addLayer({ id: "symbols", type: "symbol", source: "pts", layout: { "icon-image": "dot", "icon-allow-overlap": true, "icon-size": 1 } });
  await idle(map);
  await idle(map);
}

export function snap(name: string): { w: number; h: number } {
  const src = state.map!.getCanvas();
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(src, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  state.snaps[name] = { w: c.width, h: c.height, data: d.data };
  return { w: c.width, h: c.height };
}

/** Screen-space (device px) distance from a pixel to the nearest drawn segment. */
function bandMask(s: Snap, extraCss: number): Uint8Array {
  const map = state.map!;
  const t = createGeoTransform(reference);
  const dpr = s.w / map.getCanvas().clientWidth;
  const mask = new Uint8Array(s.w * s.h);
  const reach = (WIDTH / 2 + extraCss) * dpr;
  for (const pts of LINES) {
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const a = map.project(t.forward(pts[i]!, pts[i + 1]!));
      const b = map.project(t.forward(pts[i + 2]!, pts[i + 3]!));
      const ax = a.x * dpr, ay = a.y * dpr, bx = b.x * dpr, by = b.y * dpr;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - reach)), x1 = Math.min(s.w - 1, Math.ceil(Math.max(ax, bx) + reach));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - reach)), y1 = Math.min(s.h - 1, Math.ceil(Math.max(ay, by) + reach));
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const u = l2 > 0 ? Math.max(0, Math.min(1, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / l2)) : 0;
        if (Math.hypot(x + 0.5 - (ax + u * dx), y + 0.5 - (ay + u * dy)) <= reach) mask[y * s.w + x] = 1;
      }
    }
  }
  return mask;
}

/** Pixels that differ by more than 2 in any channel, in total and outside the band the add-on's strokes cover. */
export function diff([a, b]: [string, string]): { pixels: number; differing: number; outsideBand: number } {
  const A = state.snaps[a]!, B = state.snaps[b]!;
  const mask = bandMask(A, 2);
  let differing = 0, outsideBand = 0;
  for (let i = 0; i < A.w * A.h; i++) {
    let d = false;
    for (let k = 0; k < 4; k++) if (Math.abs(A.data[i * 4 + k]! - B.data[i * 4 + k]!) > 2) d = true;
    if (d) { differing++; if (!mask[i]) outsideBand++; }
  }
  return { pixels: A.w * A.h, differing, outsideBand };
}

/** Red pixels in a snapshot, and the colour at the device pixel under a source point. */
export function strokeProbe(name: string): { red: number; atMidpoint: number[] } {
  const s = state.snaps[name]!;
  let red = 0;
  for (let i = 0; i < s.w * s.h; i++) if (s.data[i * 4]! > 170 && s.data[i * 4 + 1]! < 60 && s.data[i * 4 + 2]! < 60) red++;
  const map = state.map!;
  const dpr = s.w / map.getCanvas().clientWidth;
  const p = map.project(createGeoTransform(reference).forward(50, 10));
  const o = (Math.floor(p.y * dpr) * s.w + Math.floor(p.x * dpr)) * 4;
  return { red, atMidpoint: [s.data[o]!, s.data[o + 1]!, s.data[o + 2]!, s.data[o + 3]!] };
}

export async function loseAndRestore(): Promise<{ stages: string[] }> {
  const map = state.map!;
  const canvas = map.getCanvas();
  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
  const ext = gl.getExtension("WEBGL_lose_context")!;
  const stages: string[] = [];
  const within = <T>(what: string, p: Promise<T>) =>
    Promise.race([p.then((v) => (stages.push(what), v)), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${stages.join(",")}`)), 8000))]);
  const lost = new Promise<void>((r) => canvas.addEventListener("webglcontextlost", () => r(), { once: true }));
  ext.loseContext();
  await within("lost", lost);
  // restoreContext() is ignored unless the loss event has finished dispatching and was cancelled, so leave this task first.
  await new Promise((r) => setTimeout(r, 50));
  const restored = new Promise<void>((r) => canvas.addEventListener("webglcontextrestored", () => r(), { once: true }));
  ext.restoreContext();
  await within("restored", restored);
  await within("idle1", idle(map));
  await within("idle2", idle(map));
  return { stages };
}

export function info() {
  return {
    errors: state.errors,
    mapErrors: state.mapErrors,
    stateDiffs: state.stateDiffs,
    frames: state.frames,
    diagnostics: state.layer?.getDiagnostics(),
    version: maplibregl.getVersion(),
  };
}

export async function repaint(): Promise<void> {
  await idle(state.map!);
}
