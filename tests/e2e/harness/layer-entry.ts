import maplibregl from "maplibre-gl";
import { createPVecLayer, type PVecLayer } from "../../../src/index";
import { configureEngine } from "../../../src/layer/internal";
import { loadEvaluator } from "../../../src/wasm/loader";
import { Epsg4326Adapter } from "../../../src/transform/crs";
import { createGeoTransform } from "../../../src/transform/georeference";
import { lngLatToMercator, mercatorToLngLat } from "../../../src/transform/projection";
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

/** Copy of the map canvas taken at the end of a frame, the only point where a restored context still holds its pixels. */
const frame = (map: maplibregl.Map) =>
  new Promise<Snap>((resolve) => {
    map.once("render", () => {
      const gl = map.getCanvas().getContext("webgl2") as WebGL2RenderingContext;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const raw = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) data.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      resolve({ w, h, data });
    });
    map.triggerRepaint();
  });

export async function snap(name: string): Promise<{ w: number; h: number; corner: number[]; centre: number[] }> {
  const s = (state.snaps[name] = await frame(state.map!));
  const at = (x: number, y: number) => Array.from(s.data.slice((y * s.w + x) * 4, (y * s.w + x) * 4 + 4));
  return { w: s.w, h: s.h, corner: at(2, 2), centre: at(Math.floor(s.w / 2), Math.floor(s.h / 2)) };
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

// The context-loss specs drive the layer on a bare WebGL2 canvas with a small camera of their own. MapLibre's own
// recovery after a forced loss is not what is under test here, and it does not repaint in headless SwiftShader.
const SIZE = 320;
const cam = { zoom: 17 };
const world = () => 512 * 2 ** cam.zoom;
const standalone = {
  canvas: undefined as HTMLCanvasElement | undefined,
  gl: undefined as WebGL2RenderingContext | undefined,
  map: undefined as unknown,
};

export async function openStandalone(o: { fixture: string; debug?: boolean }): Promise<void> {
  state.errors = [];
  state.stateDiffs = [];
  document.body.replaceChildren();
  const canvas = (standalone.canvas = document.createElement("canvas"));
  canvas.width = SIZE;
  canvas.height = SIZE;
  canvas.style.cssText = `width:${SIZE}px;height:${SIZE}px`;
  document.body.appendChild(canvas);
  const gl = (standalone.gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true })!);
  const [cx, cy] = lngLatToMercator(CENTER[0], CENTER[1]);
  const map = {
    getCanvas: () => canvas,
    getZoom: () => cam.zoom,
    triggerRepaint: () => undefined,
    project: ([lng, lat]: [number, number]) => {
      const [mx, my] = lngLatToMercator(lng, lat);
      return { x: (mx - cx) * world() + SIZE / 2, y: (my - cy) * world() + SIZE / 2 };
    },
    unproject: ([x, y]: [number, number]) => {
      const [lng, lat] = mercatorToLngLat(cx + (x - SIZE / 2) / world(), cy + (y - SIZE / 2) / world());
      return { lng, lat };
    },
  };
  standalone.map = map;
  const layer = (state.layer = createPVecLayer({ id: "pvec", source: { url: o.fixture }, georeference: { reference } }));
  layer.on("error", (e) => state.errors.push({ code: e.code, message: e.message }));
  let served = false;
  configureEngine(layer, {
    loadEvaluator: () => Promise.resolve({ instance: {} as WebAssembly.Instance, abiVersion: 1, source: "injected" as const }),
    maplibreVersion: () => undefined,
    openCursor: async () => ({ next: () => (served ? null : ((served = true), entities())) }),
    ...(o.debug === false ? {} : { onStateDiff: (d: string[]) => void state.stateDiffs.push(...d) }),
  });
  layer.registerComponent("style", { resolve: () => ({ widthPx: WIDTH, dash: [], color: "#cc0000" }) });
  layer.onAdd(map as never, gl);
  await layer.whenReady();
}

/** One frame the way MapLibre drives it: clear, render, read the pixels in the same task. */
export function frameStandalone(name: string): { red: number } {
  const gl = standalone.gl!;
  gl.viewport(0, 0, SIZE, SIZE);
  gl.clearColor(0.875, 0.906, 0.933, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  state.layer!.render(gl, {});
  const raw = new Uint8Array(SIZE * SIZE * 4);
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const data = new Uint8ClampedArray(raw.length);
  for (let y = 0; y < SIZE; y++) data.set(raw.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4);
  state.snaps[name] = { w: SIZE, h: SIZE, data };
  let red = 0;
  for (let i = 0; i < SIZE * SIZE; i++) if (data[i * 4]! > 170 && data[i * 4 + 1]! < 60 && data[i * 4 + 2]! < 60) red++;
  return { red };
}

/** Synchronous GL reads (they wait for the GPU in Chromium) issued by `n` frames of the layer. */
export function countReads(n: number): { frames: number; getParameter: number; isEnabled: number } {
  const gl = standalone.gl!;
  const out = { frames: n, getParameter: 0, isEnabled: 0 };
  const gp = gl.getParameter.bind(gl), ie = gl.isEnabled.bind(gl);
  gl.getParameter = ((p: number) => (out.getParameter++, gp(p))) as typeof gl.getParameter;
  gl.isEnabled = ((c: number) => (out.isEnabled++, ie(c))) as typeof gl.isEnabled;
  try {
    for (let i = 0; i < n; i++) frameStandalone(`reads${i}`);
  } finally {
    gl.getParameter = gp;
    gl.isEnabled = ie;
  }
  return out;
}

export async function loseAndRestoreStandalone(): Promise<void> {
  const canvas = standalone.canvas!, gl = standalone.gl!;
  const ext = gl.getExtension("WEBGL_lose_context")!;
  const lost = new Promise<void>((r) => canvas.addEventListener("webglcontextlost", () => r(), { once: true }));
  ext.loseContext();
  await lost;
  // restoreContext() is ignored unless the loss event has finished dispatching and was cancelled, so leave this task first.
  await new Promise((r) => setTimeout(r, 50));
  const restored = new Promise<void>((r) => canvas.addEventListener("webglcontextrestored", () => r(), { once: true }));
  ext.restoreContext();
  await Promise.race([restored, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("the context was not restored")), 8000))]);
  // the layer's own listener ran before ours; give any queued upload a frame
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

/** Pixels that differ by more than 2 in any channel. */
export function compare([a, b]: [string, string]): { pixels: number; differing: number } {
  const A = state.snaps[a]!, B = state.snaps[b]!;
  let differing = 0;
  for (let i = 0; i < A.w * A.h; i++) for (let k = 0; k < 4; k++) if (Math.abs(A.data[i * 4 + k]! - B.data[i * 4 + k]!) > 2) { differing++; break; }
  return { pixels: A.w * A.h, differing };
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
