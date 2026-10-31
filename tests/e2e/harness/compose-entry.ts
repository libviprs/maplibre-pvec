import { createPVecLayer, type PVecLayer } from "../../../src/index";
import { configureEngine } from "../../../src/layer/internal";
import { Epsg4326Adapter } from "../../../src/transform/crs";
import { createGeoTransform, type GeoReference } from "../../../src/transform/georeference";
import { lngLatToMercator, mercatorToLngLat } from "../../../src/transform/projection";
import { sourceToWorld } from "../../../src/transform/rebase";
import type { RawEntity } from "../../../src/decode/tier0";
import { apply } from "../../../src/render/raster/geometry";
import type { RasterProvider } from "../../../src/render/raster/provider";
import type { WireRaster } from "../../unit/helpers/raster_fixture";

// The page side of tests/e2e/rendering/106-raster-compose.spec.ts: the real layer on a real MapLibre map (the build named by `v`,
// served from /ml/<v>/), among the host's own layers. The fixture provider stands in for the pvec-wasm raster exports.

type Lib = {
  Map: new (o: Record<string, unknown>) => MapLike;
  getVersion?: () => string;
  version?: string;
};
interface MapLike {
  on(t: string, f: (...a: unknown[]) => void): void;
  once(t: string, f: (...a: unknown[]) => void): void;
  addSource(id: string, s: unknown): void;
  addLayer(l: unknown, before?: string): void;
  addImage(id: string, i: unknown): void;
  jumpTo(o: Record<string, unknown>): void;
  triggerRepaint(): void;
  project(l: [number, number]): { x: number; y: number };
  unproject(p: [number, number]): { lng: number; lat: number };
  getZoom(): number;
  getCanvas(): HTMLCanvasElement;
  remove(): void;
}

const SIZE = 320;
const SCAN = [0, 200, 200, 255] as const;
const STROKE = [204, 0, 0] as const;
const BASEMAP = [30, 160, 60, 255] as const;
const ICON = [0, 0, 200, 255] as const;
const decodeB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface Calibration {
  /** Degrees per source unit, and where source (0, 0) lands. */
  k: number;
  lng0: number;
  lat0: number;
}
const referenceOf = (c: Calibration): GeoReference => ({ kind: "affine", unit: "m", crs: Epsg4326Adapter, calibration: [c.k, 0, 0, c.k, c.lng0, c.lat0] as const });

export interface OpenOptions {
  v: "v4" | "v5" | "v6";
  ratio?: number;
  rasters: WireRaster[];
  /** Polylines in source units. */
  strokes?: number[][];
  calibration: Calibration;
  center: [number, number];
  zoom: number;
  bearing?: number;
  pitch?: number;
  basemap?: boolean;
  symbols?: boolean;
  /** Where the PVec layer goes: before this layer id, or on top when omitted. */
  beforeId?: string;
}

interface Snap { w: number; h: number; data: Uint8ClampedArray }
const state = {
  lib: undefined as Lib | undefined,
  libV: "",
  map: undefined as MapLike | undefined,
  layer: undefined as PVecLayer | undefined,
  rasters: [] as WireRaster[],
  snaps: {} as Record<string, Snap>,
  errors: [] as string[],
  stateDiffs: [] as string[],
  tileRequests: 0,
  calibration: undefined as Calibration | undefined,
  spy: { draws: 0, badBlend: 0, stencilDraws: 0, stencilEnabled: 0, inLayer: false, blend: [0, 0, 0, 0] as number[], stencilOn: false },
  zoom: 0,
  bearing: 0,
  ratio: 1,
};

async function load(v: string): Promise<Lib> {
  if (state.lib && state.libV === v) return state.lib;
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = `/ml/${v}/dist/maplibre-gl.css`;
  document.head.appendChild(css);
  let lib: Lib;
  if (v === "v6") {
    const m = (await import(/* @vite-ignore */ `/ml/${v}/dist/maplibre-gl.mjs`)) as { default?: Lib } & Lib;
    lib = (m.default ?? m) as Lib;
  } else {
    await new Promise<void>((res, rej) => {
      const s = document.createElement("script");
      s.src = `/ml/${v}/dist/maplibre-gl.js`;
      s.onload = () => res();
      s.onerror = () => rej(new Error("maplibre did not load"));
      document.head.appendChild(s);
    });
    lib = (window as unknown as { maplibregl: Lib }).maplibregl;
  }
  state.lib = lib;
  state.libV = v;
  return lib;
}

function solidDataUrl(c: readonly number[]): string {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 8;
  const g = cv.getContext("2d")!;
  g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
  g.fillRect(0, 0, 8, 8);
  return cv.toDataURL("image/png");
}

const idle = (map: MapLike) => new Promise<void>((r) => (map.triggerRepaint(), map.once("idle", () => r())));

export async function open(o: OpenOptions): Promise<{ version: string; canvas: [number, number] }> {
  const lib = await load(o.v);
  state.map?.remove();
  document.body.replaceChildren();
  Object.assign(state, { errors: [], stateDiffs: [], tileRequests: 0, rasters: o.rasters, calibration: o.calibration, zoom: o.zoom, bearing: o.bearing ?? 0, ratio: o.ratio ?? 1 });
  Object.assign(state.spy, { draws: 0, badBlend: 0, stencilDraws: 0, stencilEnabled: 0, inLayer: false });
  const host = document.createElement("div");
  host.style.cssText = `width:${SIZE}px;height:${SIZE}px;position:absolute;left:0;top:0`;
  document.body.appendChild(host);
  const [clng, clat] = o.center;
  const cover = (d: number) => [[clng - d, clat + d], [clng + d, clat + d], [clng + d, clat - d], [clng - d, clat - d]];
  const layers: unknown[] = [{ id: "bg", type: "background", paint: { "background-color": "#dfe7ee" } }];
  const sources: Record<string, unknown> = {};
  if (o.basemap) {
    sources.basemap = { type: "image", url: solidDataUrl(BASEMAP), coordinates: cover(60) };
    layers.push({ id: "basemap", type: "raster", source: "basemap" });
  }
  if (o.symbols) {
    sources.pts = { type: "geojson", data: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "MultiPoint", coordinates: [[clng, clat], [clng + 4, clat - 3], [clng - 4, clat + 3]] } }] } };
  }
  const map = (state.map = new lib.Map({
    container: host,
    center: o.center,
    zoom: o.zoom,
    bearing: o.bearing ?? 0,
    pitch: o.pitch ?? 0,
    pixelRatio: o.ratio ?? 1,
    interactive: false,
    fadeDuration: 0,
    attributionControl: false,
    antialias: false,
    preserveDrawingBuffer: true,
    canvasContextAttributes: { antialias: false, preserveDrawingBuffer: true },
    style: { version: 8, sources, layers },
  }));
  map.on("error", (e) => state.errors.push(String((e as { error?: unknown })?.error ?? e)));
  await new Promise<void>((r) => map.once("load", () => r()));

  const tiles = new Map<string, Uint8Array>();
  for (const w of o.rasters) for (const [k, b] of Object.entries(w.tiles)) tiles.set(`${w.placement.id}/${k}`, decodeB64(b));
  const provider: RasterProvider = {
    placements: () => state.rasters.map((w) => w.placement),
    tile: async (id, level, col, row) => {
      state.tileRequests++;
      return tiles.get(`${id}/${level}/${col}/${row}`)?.slice() ?? null;
    },
  };
  const layer = (state.layer = createPVecLayer({ id: "pvec", source: { url: (window as unknown as { __FIXTURE__: string }).__FIXTURE__ }, georeference: { reference: referenceOf(o.calibration) } }));
  layer.on("error", (e) => state.errors.push(`${e.code}: ${e.message}`));
  let served = !o.strokes?.length;
  const entities = (): RawEntity[] => (o.strokes ?? []).map((points, i) => ({ entityId: `s${i}`, kind: "exact", geometry: { type: "polyline", points }, bounds: { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 } }));
  configureEngine(layer, {
    loadEvaluator: () => Promise.resolve({ instance: {} as WebAssembly.Instance, abiVersion: 1, source: "injected" as const }),
    maplibreVersion: () => (lib.getVersion ? lib.getVersion() : lib.version),
    openCursor: async () => (o.strokes?.length ? { next: () => (served ? null : ((served = true), entities())) } : null),
    openRasters: async () => provider,
    onStateDiff: (d: string[]) => void state.stateDiffs.push(...d),
    onRasterFrame: (f) => {
      lastPending = f.pending;
      lastUploads = f.uploads;
    },
  });
  layer.registerComponent("style", { resolve: () => ({ widthPx: 4, dash: [], color: "#cc0000" }) });

  if (o.symbols) {
    const icon = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < 256; i++) icon.set(ICON, i * 4);
    map.addImage("dot", { width: 16, height: 16, data: icon });
    map.addLayer({ id: "symbols", type: "symbol", source: "pts", layout: { "icon-image": "dot", "icon-allow-overlap": true, "icon-size": 1 } });
  }
  installSpy(layer, map);
  map.addLayer(layer, o.beforeId);
  await layer.whenReady();
  await idle(map);
  await settle();
  return { version: lib.getVersion ? lib.getVersion() : String(lib.version), canvas: [map.getCanvas().width, map.getCanvas().height] };
}

/** Counts, inside the layer's render, the blend pair at every draw and the draws made with the stencil test on. */
function installSpy(layer: PVecLayer, map: MapLike): void {
  const gl = map.getCanvas().getContext("webgl2") as WebGL2RenderingContext;
  const s = state.spy;
  const g = gl as unknown as Record<string, (...a: number[]) => unknown>;
  const wrap = (name: string, on: (...a: number[]) => void) => {
    const orig = g[name]!;
    g[name] = function (...a: number[]) { on(...a); return orig.apply(gl, a); };
  };
  wrap("blendFunc", (a, b) => (s.blend = [a, b, a, b]));
  wrap("blendFuncSeparate", (a, b, c, d) => (s.blend = [a, b, c, d]));
  wrap("enable", (c) => { if (c === gl.STENCIL_TEST) s.stencilOn = true; });
  wrap("disable", (c) => { if (c === gl.STENCIL_TEST) s.stencilOn = false; });
  const draw = () => {
    if (!s.inLayer) return;
    s.draws++;
    if (s.stencilOn) s.stencilDraws++;
    if (!(s.blend[0] === gl.ONE && s.blend[1] === gl.ONE_MINUS_SRC_ALPHA)) s.badBlend++;
  };
  wrap("drawArrays", draw);
  wrap("drawElements", draw);
  wrap("drawArraysInstanced", draw);
  const render = layer.render.bind(layer);
  layer.render = (g2: WebGLRenderingContext | WebGL2RenderingContext, args: unknown) => {
    s.inLayer = true;
    try { render(g2, args); } finally { s.inLayer = false; }
  };
}

/** Frames until the raster has nothing left to fetch, decode or upload. */
export async function settle(): Promise<void> {
  const map = state.map!;
  let quiet = 0;
  for (let i = 0; i < 300 && quiet < 12; i++) {
    await new Promise<void>((r) => (map.triggerRepaint(), map.once("render", () => r())));
    await new Promise((r) => setTimeout(r, 20));
    quiet = lastPending === 0 && lastUploads === 0 ? quiet + 1 : 0;
  }
}
let lastPending = 1, lastUploads = 1;

/** Copy of the canvas taken at the end of a frame, the only point where the pixels are guaranteed to be there. */
const frame = (map: MapLike) =>
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

export async function snap(name: string): Promise<void> {
  state.snaps[name] = await frame(state.map!);
}

export function probe(o: { name: string; x: number; y: number }): number[] {
  const s = state.snaps[o.name]!;
  const x = Math.round(o.x * state.ratio), y = Math.round(o.y * state.ratio);
  return Array.from(s.data.subarray((y * s.w + x) * 4, (y * s.w + x) * 4 + 4));
}

/** Pixels that differ by more than 2 in any channel, over the whole frame or over a mask of another frame's icon-coloured pixels. */
export function compare(o: { a: string; b: string; onlyWhereIcon?: string }): { pixels: number; differing: number; masked: number } {
  const A = state.snaps[o.a]!, B = state.snaps[o.b]!, M = o.onlyWhereIcon ? state.snaps[o.onlyWhereIcon] : undefined;
  let differing = 0, masked = 0;
  for (let i = 0; i < A.w * A.h; i++) {
    if (M) {
      const j = i * 4;
      if (!(Math.abs(M.data[j]! - ICON[0]) < 3 && Math.abs(M.data[j + 1]! - ICON[1]) < 3 && Math.abs(M.data[j + 2]! - ICON[2]) < 3)) continue;
    }
    masked++;
    for (let k = 0; k < 4; k++) if (Math.abs(A.data[i * 4 + k]! - B.data[i * 4 + k]!) > 2) { differing++; break; }
  }
  return { pixels: A.w * A.h, differing, masked };
}

export function countColour(o: { name: string; colour: number[]; tol?: number }): number {
  const s = state.snaps[o.name]!;
  const t = o.tol ?? 3;
  let n = 0;
  for (let i = 0; i < s.w * s.h; i++) if (o.colour.every((c, k) => Math.abs(s.data[i * 4 + k]! - c) <= t)) n++;
  return n;
}

export function info() {
  return { errors: state.errors, stateDiffs: state.stateDiffs, tileRequests: state.tileRequests, spy: { ...state.spy, blend: undefined }, scan: SCAN, basemap: BASEMAP, icon: ICON, stroke: STROKE };
}

/** `layer.update({ georeference })` `n` times, alternating between two calibrations and ending on `last`. */
export async function hotUpdates(o: { n: number; a: Calibration; b: Calibration }): Promise<{ ms: number; tileRequests: number }> {
  const t0 = performance.now();
  for (let i = 0; i < o.n; i++) state.layer!.update({ georeference: { reference: referenceOf(i % 2 === 0 ? o.a : o.b) } });
  state.calibration = (o.n - 1) % 2 === 0 ? o.a : o.b;
  state.layer!.update({ georeference: { reference: referenceOf(o.b) } });
  state.calibration = o.b;
  await settle();
  return { ms: performance.now() - t0, tileRequests: state.tileRequests };
}

export function setView(o: { zoom: number; bearing: number; center: [number, number]; pitch?: number; calibration?: Calibration }): void {
  state.zoom = o.zoom;
  state.bearing = o.bearing;
  state.map!.jumpTo({ zoom: o.zoom, bearing: o.bearing, center: o.center, pitch: o.pitch ?? 0 });
  if (o.calibration) {
    state.calibration = o.calibration;
    state.layer!.update({ georeference: { reference: referenceOf(o.calibration) } });
  }
}

/** Least squares line x = a + b * y through the points. */
function fit(pts: [number, number][]): { a: number; b: number } {
  const n = pts.length;
  let sy = 0, sx = 0, syy = 0, sxy = 0;
  for (const [y, x] of pts) { sy += y; sx += x; syy += y * y; sxy += x * y; }
  const b = (n * sxy - sx * sy) / (n * syy - sy * sy);
  return { b, a: (sx - b * sy) / n };
}

/**
 * Where the scan's left edge and the stroke's centre line sit in the current frame, in device pixels. The stroke covers only the
 * middle of the edge, so the edge is read from the rows above and below it. The distance is measured across the edge.
 */
export async function alignment(name: string): Promise<{ distancePx: number; strokeRows: number; edgeRows: number; slope: number }> {
  await snap(name);
  const s = state.snaps[name]!;
  const r = state.ratio;
  const isRed = (i: number) => s.data[i]! > 140 && s.data[i + 1]! < 90 && s.data[i + 2]! < 90;
  const isScan = (i: number) => Math.abs(s.data[i]! - SCAN[0]) < 40 && Math.abs(s.data[i + 1]! - SCAN[1]) < 40 && Math.abs(s.data[i + 2]! - SCAN[2]) < 40;
  const centre: [number, number][] = [];
  let yMin = Infinity, yMax = -Infinity;
  for (let y = 0; y < s.h; y++) {
    let sum = 0, n = 0;
    for (let x = 0; x < s.w; x++) if (isRed((y * s.w + x) * 4)) { sum += x + 0.5; n++; }
    if (n >= 2 * r) { centre.push([y + 0.5, sum / n]); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y); }
  }
  if (centre.length < 6) return { distancePx: Infinity, strokeRows: centre.length, edgeRows: 0, slope: 0 };
  const line = fit(centre);
  const edge: [number, number][] = [];
  for (let y = 0; y < s.h; y++) {
    const outside = (y >= yMin - 30 * r && y <= yMin - 5 * r) || (y >= yMax + 5 * r && y <= yMax + 30 * r);
    if (!outside) continue;
    const near = line.a + line.b * (y + 0.5);
    for (let x = Math.max(0, Math.floor(near - 15 * r)); x < Math.min(s.w, near + 15 * r); x++) {
      if (isScan((y * s.w + x) * 4)) { edge.push([y + 0.5, x]); break; }
    }
  }
  if (edge.length < 6) return { distancePx: Infinity, strokeRows: centre.length, edgeRows: edge.length, slope: line.b };
  const e = fit(edge);
  const yMid = (yMin + yMax) / 2 + 0.5;
  const dx = Math.abs(e.a + e.b * yMid - (line.a + line.b * yMid));
  return { distancePx: dx / Math.sqrt(1 + line.b * line.b), strokeRows: centre.length, edgeRows: edge.length, slope: line.b };
}

/**
 * How far the corners of the first raster land from where the map's own projection puts them, on the chain the vertex shader runs:
 * the view linearised at the centre of the canvas, the corners in f64 world coordinates split into hi and lo.
 */
export function cornerError(): { corners: number[]; maxPx: number } {
  const map = state.map!, cal = state.calibration!;
  const p = state.rasters[0]!.placement;
  const geo = createGeoTransform(referenceOf(cal));
  const css = SIZE, dpr = state.ratio;
  const c = map.unproject([css / 2, css / 2]);
  const [cx, cy] = lngLatToMercator(c.lng, c.lat);
  const step = 64 / (512 * 2 ** map.getZoom());
  const at = (mx: number, my: number): [number, number] => {
    const q = map.project(mercatorToLngLat(mx, my));
    return [q.x, q.y];
  };
  const o = at(cx, cy), ex = at(cx + step, cy), ey = at(cx, cy + step);
  const a = (ex[0] - o[0]) / step, b = (ex[1] - o[1]) / step, cc = (ey[0] - o[0]) / step, d = (ey[1] - o[1]) / step;
  const out: number[] = [];
  for (const [px, py] of [[0, 0], [p.width, 0], [0, p.height], [p.width, p.height]] as const) {
    const [sx, sy] = apply(p.pixelToSource, px, py);
    const [wx, wy] = sourceToWorld(geo, sx, sy);
    const dx = wx - cx, dy = wy - cy;
    // the vertex shader's p = linear * (corner - centre), in device px with y up; the canvas centre is the origin
    const gx = dpr * a * dx + dpr * cc * dy, gy = -dpr * b * dx - dpr * d * dy;
    const chain: [number, number] = [(css * dpr) / 2 + gx, (css * dpr) / 2 - gy];
    const [lng, lat] = geo.forward(sx, sy);
    const truth = map.project([lng, lat]);
    out.push(Math.hypot(chain[0] - truth.x * dpr, chain[1] - truth.y * dpr));
  }
  return { corners: out, maxPx: Math.max(...out) };
}

export function calibrationFor(zoom: number, centre: [number, number], size = 160): Calibration {
  const k = (size * 360) / (512 * 512 * 2 ** zoom);
  return { k, lng0: centre[0] - 256 * k, lat0: centre[1] - 256 * k };
}
