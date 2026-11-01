import maplibregl from "maplibre-gl";
import { createPVecLayer, type PVecLayer } from "../../src/index";
import { configureEngine } from "../../src/layer/internal";
import { Epsg4326Adapter } from "../../src/transform/crs";
import type { RawEntity } from "../../src/decode/tier0";
import { percentile } from "../lib/stats";

// Page side of the layer run (#82 addendum). The same 1e6-segment scene as bench/hw/page.ts, but
// drawn by the real wired layer on a real MapLibre map. The cursor is the stand-in the browser
// specs use (real .pvec strokes come with the shared decoder); everything downstream of it, the
// layer, the pool, the stroke renderer and the state guard, is the shipped code.
const POLYLINES = 10;
const SEG_PER_LINE = 100_000;
const CSS_W = 1600;
const CSS_H = 1000;
const CENTER: [number, number] = [8.54, 47.37];
const COLORS = ["#cc0000", "#00aa00", "#0000cc", "#aa00aa", "#00aaaa", "#aaaa00", "#ff6600", "#6600ff", "#008866", "#884400"];
// One source unit is about one CSS pixel at zoom 17 around the centre, so the walks fill the viewport.
const LON_PER_PX = 5.36e-6, LAT_PER_PX = 3.63e-6;
const reference = {
  kind: "affine" as const,
  unit: "m" as const,
  crs: Epsg4326Adapter,
  calibration: [LON_PER_PX, 0, 0, LAT_PER_PX, CENTER[0] - (CSS_W / 2) * LON_PER_PX, CENTER[1] - (CSS_H / 2) * LAT_PER_PX] as const,
};

function walk(seed: number, n: number, w: number, h: number): number[] {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const pts: number[] = [];
  let x = rnd() * w, y = rnd() * h, a = rnd() * 6.283;
  for (let i = 0; i <= n; i++) {
    pts.push(x, y);
    a += (rnd() - 0.5) * 1.2;
    const step = 2 + rnd() * 4;
    x += Math.cos(a) * step; y += Math.sin(a) * step;
    if (x < 0 || x > w) { x = Math.min(Math.max(x, 0), w); a = Math.PI - a; }
    if (y < 0 || y > h) { y = Math.min(Math.max(y, 0), h); a = -a; }
  }
  return pts;
}

const entities = (): RawEntity[] =>
  Array.from({ length: POLYLINES }, (_, i) => ({
    entityId: `e${i}`,
    kind: "exact" as const,
    geometry: { type: "polyline" as const, points: walk(1 + i, SEG_PER_LINE, CSS_W, CSS_H) },
    bounds: { minX: 0, minY: 0, maxX: CSS_W, maxY: CSS_H },
  }));

const stats = (v: number[]) => ({ p50: percentile(v, 50), p95: percentile(v, 95), p99: percentile(v, 99), max: v.length ? Math.max(...v) : 0 });

interface Rig { map: maplibregl.Map; layer: PVecLayer; gl: WebGL2RenderingContext; errors: () => number; diffs: () => number }

async function build(debug: boolean): Promise<Rig> {
  document.body.replaceChildren();
  const host = document.createElement("div");
  host.style.cssText = `width:${CSS_W}px;height:${CSS_H}px;position:absolute;left:0;top:0`;
  document.body.appendChild(host);
  const map = new maplibregl.Map({
    container: host, center: CENTER, zoom: 17, interactive: false, fadeDuration: 0, attributionControl: false,
    style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#dfe7ee" } }] },
  });
  await new Promise<void>((r) => map.once("load", () => r()));
  const gl = map.getCanvas().getContext("webgl2") as WebGL2RenderingContext;
  let errors = 0, diffs = 0;
  map.on("error", () => errors++);
  const layer = createPVecLayer({ id: "pvec", source: { url: new URL("/p.pvec", location.href).href }, georeference: { reference } });
  layer.on("error", () => errors++);
  const queue = entities();
  configureEngine(layer, {
    loadEvaluator: () => Promise.resolve({ instance: {} as WebAssembly.Instance, abiVersion: 1, source: "injected" as const }),
    maplibreVersion: () => maplibregl.getVersion(),
    openCursor: async () => ({ next: () => { const e = queue.shift(); return e ? [e] : null; } }),
    ...(debug ? { onStateDiff: (d: string[]) => void (diffs += d.length) } : {}),
  });
  layer.registerComponent("style", { resolve: (e) => ({ widthPx: 1.5, dash: [], color: COLORS[Number(e.entityId.slice(1)) % COLORS.length]! }) });
  return { map, layer, gl, errors: () => errors, diffs: () => diffs };
}

/** Drives the map one frame per render event, panning the whole scene like bench/hw/page.ts does. */
function frames(rig: Rig, frameCount: number | undefined, durationMs: number, onFrame: (i: number, ts: number) => boolean | void): Promise<void> {
  return new Promise((resolve) => {
    let i = 0, t0 = 0;
    const step = () => {
      const ts = performance.now();
      if (!t0) t0 = ts;
      const done = onFrame(i, ts) === true;
      i++;
      if (done || (frameCount !== undefined ? i >= frameCount : ts - t0 >= durationMs)) {
        rig.map.off("render", step);
        resolve();
        return;
      }
      rig.map.setCenter([CENTER[0] + Math.sin(i / 60) * 200 * LON_PER_PX, CENTER[1]]);
      rig.map.triggerRepaint();
    };
    rig.map.on("render", step);
    rig.map.triggerRepaint();
  });
}

export async function run(o: { durationMs: number; warmupMs: number; profile?: boolean; diffFrames?: number }) {
  const rig = await build(false);
  const { map, layer, gl } = rig;
  const dpr = devicePixelRatio;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const gpuRenderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const gpuVendor = String(info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));

  let calls = 0;
  const orig = gl.drawArraysInstanced.bind(gl);
  gl.drawArraysInstanced = ((...a: Parameters<typeof orig>) => { calls++; return orig(...a); }) as typeof orig;

  // Optional breakdown: JavaScript time per GL entry point inside layer.render, to see where a frame's CPU goes.
  const glTime = new Map<string, { n: number; ms: number }>();
  let inRender = false;
  if (o.profile) {
    for (const name of Object.getOwnPropertyNames(WebGL2RenderingContext.prototype)) {
      const f = (gl as unknown as Record<string, unknown>)[name];
      if (typeof f !== "function" || name === "constructor") continue;
      (gl as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => {
        if (!inRender) return (f as (...x: unknown[]) => unknown).apply(gl, a);
        const t = performance.now();
        const r = (f as (...x: unknown[]) => unknown).apply(gl, a);
        const key = name === "getParameter" ? `getParameter(${String(a[0])})` : name;
        const e = glTime.get(key) ?? { n: 0, ms: 0 };
        e.n++; e.ms += performance.now() - t; glTime.set(key, e);
        return r;
      };
    }
  }
  // Time the layer's own render() and, where the engine has timer queries, its GPU time.
  const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const pending: WebGLQuery[] = [];
  const gpuMs: number[] = [];
  const poll = () => {
    while (pending.length) {
      const q = pending[0]!;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!gl.getParameter(timer!.GPU_DISJOINT_EXT)) gpuMs.push(Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6);
      gl.deleteQuery(q); pending.shift();
    }
  };
  let lastRenderMs = 0, lastCalls = 0;
  const inner = layer.render.bind(layer);
  layer.render = (g, args) => {
    const q = timer && pending.length < 8 ? gl.createQuery() : null;
    if (q) gl.beginQuery(timer!.TIME_ELAPSED_EXT, q);
    const before = calls;
    const s = performance.now();
    inRender = true;
    inner(g, args);
    inRender = false;
    lastRenderMs = performance.now() - s;
    lastCalls = calls - before;
    if (q) { gl.endQuery(timer!.TIME_ELAPSED_EXT); pending.push(q); }
    if (timer) poll();
  };

  // Count the bytes the pool uploads inside layer.render, so the settle phase can say when the whole scene is on the GPU.
  let uploadedNow = 0, uploadedTotal = 0, maxUploadFrame = 0;
  const bsd = gl.bufferSubData.bind(gl) as (...a: unknown[]) => void;
  gl.bufferSubData = ((...a: unknown[]) => { if (inRender) uploadedNow += (a[2] as ArrayBufferView).byteLength; bsd(...a); }) as typeof gl.bufferSubData;
  const bd = gl.bufferData.bind(gl) as (...a: unknown[]) => void;
  gl.bufferData = ((...a: unknown[]) => { if (inRender) uploadedNow += typeof a[1] === "number" ? a[1] : (a[1] as ArrayBufferView).byteLength; bd(...a); }) as typeof gl.bufferData;

  // Settle: the pool uploads the scene within its per-frame budget. Count frames from addLayer until all ten ranges draw,
  // nothing is left to upload, and that has held for three frames.
  const t0 = performance.now();
  map.addLayer(layer as never);
  let settleFrames = 0, settleMax = 0, steady = 0;
  const settling = frames(rig, undefined, 180_000, () => {
    settleFrames++;
    settleMax = Math.max(settleMax, lastRenderMs);
    uploadedTotal += uploadedNow;
    maxUploadFrame = Math.max(maxUploadFrame, uploadedNow);
    const quiet = uploadedNow === 0 && uploadedTotal > 0 && lastCalls === POLYLINES;
    uploadedNow = 0;
    steady = quiet ? steady + 1 : 0;
    return steady >= 3;
  });
  await layer.whenReady();
  await settling;
  const settleMs = performance.now() - t0;

  const interval: number[] = [], render: number[] = [], perFrameCalls: number[] = [];
  let last = 0, start = 0;
  await frames(rig, undefined, o.warmupMs + o.durationMs, (_i, ts) => {
    if (!start) start = ts;
    const recording = ts - start >= o.warmupMs;
    if (recording && last) { interval.push(ts - last); render.push(lastRenderMs); perFrameCalls.push(lastCalls); }
    last = ts;
  });
  const recordedMs = interval.reduce((a, b) => a + b, 0);
  const segments = POLYLINES * SEG_PER_LINE;
  const glError = gl.getError();
  const errors = rig.errors();
  map.remove();

  // The guard's debug diff is expensive, so it gets its own short run instead of the timed one.
  const dbg = await build(true);
  dbg.map.addLayer(dbg.layer as never);
  await dbg.layer.whenReady();
  await frames(dbg, 400, 0, () => undefined);
  const stateDiffs = dbg.diffs();
  const errorsDebug = dbg.errors();
  dbg.map.remove();

  const fs = stats(interval), cs = stats(render);
  return {
    gpuRenderer, gpuVendor, dpr, viewport: [CSS_W, CSS_H] as [number, number], timerQuery: !!timer, glError,
    glBreakdown: o.profile ? [...glTime].map(([name, v]) => ({ name, calls: v.n, ms: v.ms })).sort((a, b) => b.ms - a.ms).slice(0, 12) : undefined,
    layer: {
      durationMs: Math.round(recordedMs), segments, stateDiffs, errors: errors + errorsDebug,
      frames: { count: interval.length, p50Ms: fs.p50, p95Ms: fs.p95, p99Ms: fs.p99, maxMs: fs.max, over20Ms: interval.filter((v) => v > 20).length },
      drawCalls: { perFrame: percentile(perFrameCalls, 50) },
      cpu: { renderP50Ms: cs.p50, renderP95Ms: cs.p95, renderMaxMs: cs.max },
      gpu: gpuMs.length ? { frameP50Ms: percentile(gpuMs, 50), frameP95Ms: percentile(gpuMs, 95) } : null,
      settle: { frames: settleFrames, ms: Math.round(settleMs), renderMaxMs: settleMax, uploadedBytes: uploadedTotal, maxUploadBytesPerFrame: maxUploadFrame },
    },
  };
}
