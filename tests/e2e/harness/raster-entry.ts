import { createPVecLayer, type PVecLayer } from "../../../src/index";
import { configureEngine } from "../../../src/layer/internal";
import { Epsg4326Adapter } from "../../../src/transform/crs";
import { createGeoTransform } from "../../../src/transform/georeference";
import { lngLatToMercator, mercatorToLngLat } from "../../../src/transform/projection";
import type { RawEntity } from "../../../src/decode/tier0";
import { apply, compose, invert, type Mat6, type RasterPlacement } from "../../../src/render/raster/geometry";
import { RasterRefusedError, type RasterProvider } from "../../../src/render/raster/provider";
import type { RasterFrameStats } from "../../../src/render/raster/renderer";
import type { WireRaster } from "../../unit/helpers/raster_fixture";

// The page side of tests/e2e/102-raster.spec.ts: the real layer on a bare WebGL2 canvas, a map stand-in that projects with the
// real mercator maths, a fixture provider in place of the pvec-wasm raster exports, and a CPU reference render that does not
// share code with the renderer (it inverts the placement and samples bilinearly per tile, the way CLAMP_TO_EDGE does).

const W = 640, H = 480, ZOOM = 18;
const CENTER: [number, number] = [8.54, 47.37];
const reference = { kind: "affine" as const, unit: "m" as const, crs: Epsg4326Adapter, calibration: [1e-5, 0, 0, 1e-5, CENTER[0] - 0.0005, CENTER[1] - 0.0005] as const };
const geo = createGeoTransform(reference);
const BACKGROUND = [223, 231, 238, 255];
const STROKE_WIDTH = 4;
const world = () => 512 * 2 ** ZOOM;
const [CX0, CY0] = lngLatToMercator(...geo.forward(75, 48));
/** The camera centre in mercator units; `setCamera` moves it in device pixels from where it started. */
let CX = CX0, CY = CY0;
const project = (sx: number, sy: number): [number, number] => {
  const [mx, my] = lngLatToMercator(...geo.forward(sx, sy));
  return [(mx - CX) * world() + W / 2, (my - CY) * world() + H / 2];
};

interface Snap { w: number; h: number; data: Uint8ClampedArray }
const kindOf = (p: RasterPlacement) => (p.codec === 2 ? "jpeg" : p.bitDepth === 1 ? "png1" : "png");
const decodeB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const counters = { mainDecodes: 0 };
const origBitmap = window.createImageBitmap.bind(window);
window.createImageBitmap = ((...a: Parameters<typeof createImageBitmap>) => (counters.mainDecodes++, origBitmap(...a))) as typeof createImageBitmap;
const origDecode = HTMLImageElement.prototype.decode;
HTMLImageElement.prototype.decode = function (this: HTMLImageElement) { counters.mainDecodes++; return origDecode.call(this); };

const state = {
  canvas: undefined as HTMLCanvasElement | undefined,
  gl: undefined as WebGL2RenderingContext | undefined,
  layer: undefined as PVecLayer | undefined,
  map: undefined as unknown,
  wire: [] as WireRaster[],
  stroke: [] as number[],
  snaps: {} as Record<string, Snap>,
  errors: [] as { code: string; message: string }[],
  events: [] as { capability: string; required: boolean; action: string }[],
  skips: [] as { rasterId: number; rule: string; message: string }[],
  stateDiffs: [] as string[],
  frames: undefined as RasterFrameStats | undefined,
  uploadsPerFrame: [] as number[],
  renderMs: [] as number[],
  decodeMs: {} as Record<string, number[]>,
  workerDecodes: 0,
  held: 0,
  tileRequests: 0,
  gate: undefined as { fromLevel: number; waiting: (() => void)[]; open: boolean } | undefined,
};

export interface OpenOptions {
  rasters: WireRaster[] | null;
  /** Image-pixel points of raster 0 the stroke runs through. */
  stroke?: number[][];
  hold?: { fromLevel: number };
  debug?: boolean;
  gpuBytes?: number;
  /** `limits.maxDecodedBytes`. */
  maxDecodedBytes?: number;
  /** Rasters the provider refuses by rule, as the module does for a hostile tile: raster id to `RASTER-NN` or `LIMIT-NN`. */
  refuse?: Record<number, string>;
  /** Rasters whose tiles keep a valid header and get a corrupt body. */
  corrupt?: number[];
}

export async function openRaster(o: OpenOptions): Promise<void> {
  if (state.layer && state.map && state.gl) state.layer.onRemove(state.map as never, state.gl);
  Object.assign(state, { errors: [], events: [], skips: [], stateDiffs: [], frames: undefined, uploadsPerFrame: [], renderMs: [], decodeMs: {}, workerDecodes: 0, held: 0, tileRequests: 0, gate: o.hold ? { ...o.hold, waiting: [], open: false } : undefined });
  counters.mainDecodes = 0;
  document.body.replaceChildren();
  const canvas = (state.canvas = document.createElement("canvas"));
  canvas.width = W;
  canvas.height = H;
  canvas.style.cssText = `width:${W}px;height:${H}px`;
  document.body.appendChild(canvas);
  const gl = (state.gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, antialias: false })!);
  const map = {
    getCanvas: () => canvas,
    getZoom: () => ZOOM,
    triggerRepaint: () => undefined,
    project: ([lng, lat]: [number, number]) => {
      const [mx, my] = lngLatToMercator(lng, lat);
      return { x: (mx - CX) * world() + W / 2, y: (my - CY) * world() + H / 2 };
    },
    unproject: ([x, y]: [number, number]) => {
      const [lng, lat] = mercatorToLngLat(CX + (x - W / 2) / world(), CY + (y - H / 2) / world());
      return { lng, lat };
    },
  };
  state.map = map;
  state.wire = o.rasters ?? [];
  const tiles = new Map<string, Uint8Array>();
  for (const w of state.wire) for (const [k, b] of Object.entries(w.tiles)) tiles.set(`${w.placement.id}/${k}`, decodeB64(b));
  const provider: RasterProvider = {
    placements: () => state.wire.map((w) => w.placement),
    tile: async (id, level, col, row) => {
      state.tileRequests++;
      const rule = o.refuse?.[id];
      if (rule) throw new RasterRefusedError(rule, `${rule}: the module refused raster ${id}`);
      // the renderer owns the bytes it is handed (they are transferred to the decode worker), so hand out a copy
      const g = state.gate;
      if (g && !g.open && level >= g.fromLevel) {
        state.held++;
        await new Promise<void>((r) => g.waiting.push(r));
      }
      const b = tiles.get(`${id}/${level}/${col}/${row}`)?.slice() ?? null;
      // a valid header and a body the decoder cannot read: flip the second half
      if (b && o.corrupt?.includes(id)) for (let i = Math.floor(b.length / 2); i < b.length - 12; i++) b[i] = b[i]! ^ 0xa5;
      return b;
    },
  };
  const p0 = state.wire[0]?.placement;
  state.stroke = [];
  if (o.stroke && p0) for (const [x, y] of o.stroke) state.stroke.push(...apply(p0.pixelToSource, x! + 0.5, y! + 0.5));
  const layer = (state.layer = createPVecLayer({ id: "pvec", source: { url: (window as unknown as { __FIXTURE__: string }).__FIXTURE__ }, georeference: { reference }, ...(o.gpuBytes ? { cache: { gpuBytes: o.gpuBytes } } : {}), ...(o.maxDecodedBytes ? { limits: { maxDecodedBytes: o.maxDecodedBytes } } : {}) }));
  layer.on("error", (e) => state.errors.push({ code: e.code, message: e.message }));
  layer.on("capabilityunsupported", (e) => state.events.push({ capability: e.capability, required: e.required, action: e.action }));
  layer.on("rasterskipped", (e) => state.skips.push({ rasterId: e.rasterId, rule: e.rule, message: e.message }));
  let served = !state.stroke.length;
  const entities = (): RawEntity[] => [{ entityId: "e0", kind: "exact", geometry: { type: "polyline", points: state.stroke }, bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 } }];
  configureEngine(layer, {
    loadEvaluator: () => Promise.resolve({ instance: {} as WebAssembly.Instance, abiVersion: 1, source: "injected" as const }),
    maplibreVersion: () => undefined,
    openCursor: async () => (state.stroke.length ? { next: () => (served ? null : ((served = true), entities())) } : null),
    openRasters: async () => (o.rasters === null ? null : provider),
    onRasterFrame: (s) => {
      state.frames = s;
      if (s.uploads) state.uploadsPerFrame.push(s.uploads);
    },
    onRasterDecode: (e) => {
      state.workerDecodes++;
      const p = state.wire.find((w) => w.placement.id === e.id)!.placement;
      (state.decodeMs[kindOf(p)] ??= []).push(e.ms);
    },
    ...(o.debug === false ? {} : o.debug ? { onStateDiff: (d: string[]) => void state.stateDiffs.push(...d) } : {}),
  });
  layer.registerComponent("style", { resolve: () => ({ widthPx: STROKE_WIDTH, dash: [], color: "#cc0000" }) });
  layer.onAdd(map as never, gl);
  await layer.whenReady();
}

export function release(): void {
  const g = state.gate;
  if (!g) return;
  g.open = true;
  for (const r of g.waiting.splice(0)) r();
}

/** One frame the way MapLibre drives it: clear, render, read the pixels in the same task. */
export function frame(name: string): void {
  const gl = state.gl!;
  gl.viewport(0, 0, W, H);
  gl.clearColor(0.875, 0.906, 0.933, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const t0 = performance.now();
  state.layer!.render(gl, {});
  state.renderMs.push(performance.now() - t0);
  const raw = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const data = new Uint8ClampedArray(raw.length);
  for (let y = 0; y < H; y++) data.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  state.snaps[name] = { w: W, h: H, data };
}

/** Frames until nothing uploads for a while: the tiles that can arrive have arrived. */
export async function settle(): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < 400 && quiet < 15; i++) {
    frame("settle");
    await new Promise((r) => setTimeout(r, 10));
    quiet = state.frames && state.frames.uploads === 0 ? quiet + 1 : 0;
  }
}

/** Frames without reading pixels, for `n` animation frames: the layer's own work per frame and the decoded tier while tiles decode. */
export async function runFrames(n: number): Promise<{ layerMs: number[]; maxDecodedTier: number; decodesBefore: number; decodesAfter: number }> {
  const gl = state.gl!;
  const layerMs: number[] = [];
  let maxDecodedTier = 0;
  const decodesBefore = state.workerDecodes;
  for (let i = 0; i < n; i++) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    gl.viewport(0, 0, W, H);
    gl.clear(gl.COLOR_BUFFER_BIT);
    state.layer!.render(gl, {});
    if (state.frames) layerMs.push(state.frames.renderMs);
    maxDecodedTier = Math.max(maxDecodedTier, state.layer!.getDiagnostics().bytes.decodedTier);
  }
  return { layerMs, maxDecodedTier, decodesBefore, decodesAfter: state.workerDecodes };
}

/** Moves the camera to `px`, `py` device pixels from its starting point. */
export function setCamera(o: { px: number; py: number }): void {
  CX = CX0 + o.px / world();
  CY = CY0 + o.py / world();
}

/** Pans for `ms` at `vx` device px a second, one layer frame per animation frame, and reports what the budgets did meanwhile. */
export async function pan(o: { ms: number; vx: number; px0?: number }): Promise<{ frames: number; maxGpuTier: number; maxDecodedTier: number; glErrors: number; p95Ms: number; p95SteadyMs: number; p95UploadMs: number; p95PrepareMs: number; maxMs: number; stateDiffs: string[]; tileRequests: number; decodes: number }> {
  const gl = state.gl!;
  const t0 = performance.now();
  const times: number[] = [], steady: number[] = [], upload: number[] = [], prepare: number[] = [];
  let frames = 0, maxGpuTier = 0, maxDecodedTier = 0, glErrors = 0;
  const px0 = o.px0 ?? 0;
  while (performance.now() - t0 < o.ms) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    setCamera({ px: px0 + ((performance.now() - t0) / 1000) * o.vx, py: 0 });
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.875, 0.906, 0.933, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const a = performance.now();
    state.layer!.render(gl, {});
    const ms = performance.now() - a;
    times.push(ms);
    (state.frames?.uploads ? upload : steady).push(ms);
    if (state.frames) prepare.push(state.frames.renderMs);
    frames++;
    const d = state.layer!.getDiagnostics().bytes;
    maxGpuTier = Math.max(maxGpuTier, d.gpuTier);
    maxDecodedTier = Math.max(maxDecodedTier, d.decodedTier);
    if (frames % 50 === 0) while (gl.getError() !== gl.NO_ERROR) glErrors++;
  }
  while (gl.getError() !== gl.NO_ERROR) glErrors++;
  const p95 = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? 0;
  return { frames, maxGpuTier, maxDecodedTier, glErrors, p95Ms: p95(times), p95SteadyMs: p95(steady), p95UploadMs: p95(upload), p95PrepareMs: p95(prepare), maxMs: times.at(-1) ?? 0, stateDiffs: state.stateDiffs, tileRequests: state.tileRequests, decodes: state.workerDecodes };
}

/** Forces a context loss and waits for the restore, the way a browser reclaiming the GPU would. */
export async function loseAndRestore(): Promise<void> {
  const gl = state.gl!;
  const ext = gl.getExtension("WEBGL_lose_context")!;
  const lost = new Promise<void>((r) => state.canvas!.addEventListener("webglcontextlost", () => r(), { once: true }));
  ext.loseContext();
  await lost;
  // restoreContext() is ignored unless the loss event has finished dispatching and was cancelled, so leave this task first.
  await new Promise((r) => setTimeout(r, 50));
  const back = new Promise<void>((r) => state.canvas!.addEventListener("webglcontextrestored", () => r(), { once: true }));
  ext.restoreContext();
  await Promise.race([back, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("the context was not restored")), 8000))]);
}

/** `layer.update({ raster })`, the host's runtime switch. */
export function setRaster(enabled: boolean): void {
  state.layer!.update({ raster: { enabled } });
}

export function steadyFrames(n: number): void {
  state.renderMs = [];
  for (let i = 0; i < n; i++) frame(`steady${i}`);
}

export function stats() {
  const p0 = state.wire[0]?.placement;
  return {
    levels: state.frames?.levels ?? [],
    textures: state.frames?.textures ?? 0,
    pending: state.frames?.pending ?? 0,
    held: state.held,
    tileRequests: state.tileRequests,
    gpuBudget: state.layer?.getDiagnostics().bytes.gpuTier ?? 0,
    raster: state.frames,
    decodedTier: state.layer?.getDiagnostics().bytes.decodedTier ?? 0,
    errors: state.errors,
    events: state.events,
    skips: state.skips,
    stateDiffs: state.stateDiffs,
    mainThreadDecodes: counters.mainDecodes,
    workerDecodes: state.workerDecodes,
    gpuTierBytes: state.layer?.getDiagnostics().bytes.gpuTier ?? 0,
    tileBytes: p0 ? p0.tileEdge * p0.tileEdge * 4 : 0,
    decodeMs: state.decodeMs,
    uploadsPerFrame: state.uploadsPerFrame,
    renderMs: state.renderMs,
  };
}

/** The affine from a raster's pixels to device pixels, fitted to the exact projection of three corners. */
function deviceMap(p: RasterPlacement): Mat6 {
  const at = (x: number, y: number) => project(...apply(p.pixelToSource, x, y));
  const o = at(0, 0), ex = at(p.width, 0), ey = at(0, p.height);
  const a = (ex[0] - o[0]) / p.width, c = (ex[1] - o[1]) / p.width, b = (ey[0] - o[0]) / p.height, d = (ey[1] - o[1]) / p.height;
  return [a, b, c, d, o[0], o[1]];
}

function strokeMask(): Uint8Array {
  const mask = new Uint8Array(W * H);
  const reach = STROKE_WIDTH / 2 + 3;
  for (let i = 0; i + 3 < state.stroke.length; i += 2) {
    const a = project(state.stroke[i]!, state.stroke[i + 1]!), b = project(state.stroke[i + 2]!, state.stroke[i + 3]!);
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    for (let y = Math.max(0, Math.floor(Math.min(a[1], b[1]) - reach)); y <= Math.min(H - 1, Math.ceil(Math.max(a[1], b[1]) + reach)); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(a[0], b[0]) - reach)); x <= Math.min(W - 1, Math.ceil(Math.max(a[0], b[0]) + reach)); x++) {
        const u = l2 > 0 ? Math.max(0, Math.min(1, ((x + 0.5 - a[0]) * dx + (y + 0.5 - a[1]) * dy) / l2)) : 0;
        if (Math.hypot(x + 0.5 - (a[0] + u * dx), y + 0.5 - (a[1] + u * dy)) <= reach) mask[y * W + x] = 1;
      }
    }
  }
  return mask;
}

/** CPU reference of the full-resolution level: inverse placement, bilinear per tile with CLAMP_TO_EDGE, opacity over the background. */
function referenceRender(dx = 0, dy = 0): { data: Uint8ClampedArray; covered: number } {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) out.set(BACKGROUND, i * 4);
  let covered = 0;
  const ordered = [...state.wire].sort((a, b) => a.placement.band - b.placement.band || a.placement.id - b.placement.id);
  for (const w of ordered) {
    const p = w.placement;
    const inv = invert(deviceMap(p))!;
    const img = decodeB64(w.image);
    const E = p.tileEdge;
    // The producer's padding is magenta in the fixture (white once a gray encoder has taken its red channel); a sample reaching
    // beyond the picture inside a tile reads it.
    const pad = kindOf(p) === "png" ? [255, 0, 255, 255] : [255, 255, 255, 255];
    const texel = (col: number, row: number, tx: number, ty: number, k: number) => {
      const x = col * E + tx, y = row * E + ty;
      return x < p.width && y < p.height ? img[(y * p.width + x) * 4 + k]! : pad[k]!;
    };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [fx, fy] = apply(inv, x + 0.5 + dx, y + 0.5 + dy);
        if (!(fx >= p.visibleBox[0] && fx < p.visibleBox[2] && fy >= p.visibleBox[1] && fy < p.visibleBox[3])) continue;
        const col = Math.floor(fx / E), row = Math.floor(fy / E);
        const sx = fx - col * E - 0.5, sy = fy - row * E - 0.5;
        const x0 = Math.floor(sx), y0 = Math.floor(sy), wx = sx - x0, wy = sy - y0;
        const cl = (v: number) => Math.max(0, Math.min(E - 1, v));
        const op = p.opacity / 255;
        const px = [0, 0, 0, 0].map((_, k) => {
          const v = (1 - wy) * ((1 - wx) * texel(col, row, cl(x0), cl(y0), k) + wx * texel(col, row, cl(x0 + 1), cl(y0), k)) + wy * ((1 - wx) * texel(col, row, cl(x0), cl(y0 + 1), k) + wx * texel(col, row, cl(x0 + 1), cl(y0 + 1), k));
          return v;
        });
        const a = (px[3]! / 255) * op;
        for (let k = 0; k < 3; k++) out[(y * W + x) * 4 + k] = px[k]! * op + out[(y * W + x) * 4 + k]! * (1 - a);
        covered++;
      }
    }
  }
  return { data: out, covered };
}

/** Pixels that differ from the CPU reference by more than 2 in a channel, outside the stroke's band when `strokeBand` is set. */
export function diffReference(o: { name: string; strokeBand?: boolean }): { pixels: number; differing: number; covered: number; sample: number[][] } {
  const s = state.snaps[o.name]!;
  // Software rasterisers snap vertices to a coarse subpixel grid (SwiftShader: well above a GPU's 1/256 px), so a pixel passes when
  // every channel lies within 2 of the range the reference takes over positions shifted by up to SNAP px in either axis. Hardware numbers would use a smaller SNAP.
  const SNAP = 0.06;
  const ref = referenceRender();
  const alts = [[SNAP, 0], [-SNAP, 0], [0, SNAP], [0, -SNAP], [SNAP, SNAP], [-SNAP, -SNAP], [SNAP, -SNAP], [-SNAP, SNAP]].map(([a, b]) => referenceRender(a, b).data);
  const mask = o.strokeBand ? strokeMask() : undefined;
  let differing = 0;
  const sample: number[][] = [];
  for (let i = 0; i < W * H; i++) {
    if (mask?.[i]) continue;
    let outside = false;
    for (let k = 0; k < 4 && !outside; k++) {
      let lo = ref.data[i * 4 + k]!, hi = lo;
      for (const d of alts) { const v = d[i * 4 + k]!; if (v < lo) lo = v; if (v > hi) hi = v; }
      outside = s.data[i * 4 + k]! < lo - 2 || s.data[i * 4 + k]! > hi + 2;
    }
    if (outside) {
      differing++;
      if (differing % 97 === 1 && sample.length < 14) sample.push([i % W, Math.floor(i / W), ...Array.from(s.data.slice(i * 4, i * 4 + 3)), ...Array.from(ref.data.slice(i * 4, i * 4 + 3))]);
    }
  }
  return { pixels: W * H, differing, covered: ref.covered, sample };
}

export function colourCount(o: { name: string; magenta: boolean }): { magenta: number; drawn: number } {
  const s = state.snaps[o.name]!;
  let magenta = 0, drawn = 0;
  for (let i = 0; i < W * H; i++) {
    const [r, g, b] = [s.data[i * 4]!, s.data[i * 4 + 1]!, s.data[i * 4 + 2]!];
    if (r > 200 && g < 60 && b > 200) magenta++;
    if (BACKGROUND.some((v, k) => Math.abs(v - s.data[i * 4 + k]!) > 6)) drawn++;
  }
  return { magenta, drawn };
}

/** The colour at the device pixel under a raster's image pixel. */
export function probePixel(o: { name: string; raster: number; x: number; y: number }): number[] {
  const p = state.wire.find((w) => w.placement.id === o.raster)!.placement;
  const [dx, dy] = apply(deviceMap(p), o.x + 0.5, o.y + 0.5);
  const s = state.snaps[o.name]!;
  const i = (Math.floor(dy) * W + Math.floor(dx)) * 4;
  return Array.from(s.data.slice(i, i + 4));
}

export function compare([a, b]: [string, string]): { pixels: number; differing: number } {
  const A = state.snaps[a]!, B = state.snaps[b]!;
  let differing = 0;
  for (let i = 0; i < A.w * A.h; i++) for (let k = 0; k < 4; k++) if (Math.abs(A.data[i * 4 + k]! - B.data[i * 4 + k]!) > 2) { differing++; break; }
  return { pixels: A.w * A.h, differing };
}

/** Synchronous GL reads and CULL_FACE enables issued by `n` frames. */
export function countReads(n: number): { frames: number; getParameter: number; isEnabled: number; cullFaceEnabled: number } {
  const gl = state.gl!;
  const out = { frames: n, getParameter: 0, isEnabled: 0, cullFaceEnabled: 0 };
  const gp = gl.getParameter.bind(gl), ie = gl.isEnabled.bind(gl), en = gl.enable.bind(gl);
  gl.getParameter = ((p: number) => (out.getParameter++, gp(p))) as typeof gl.getParameter;
  gl.isEnabled = ((c: number) => (out.isEnabled++, ie(c))) as typeof gl.isEnabled;
  gl.enable = ((c: number) => (c === gl.CULL_FACE && out.cullFaceEnabled++, en(c))) as typeof gl.enable;
  try {
    for (let i = 0; i < n; i++) frame(`reads${i}`);
  } finally {
    gl.getParameter = gp;
    gl.isEnabled = ie;
    gl.enable = en;
  }
  return out;
}

void compose;
