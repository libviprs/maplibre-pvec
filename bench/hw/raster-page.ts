import { spawnDecodeWorker } from "../../src/workers/raster_decode";
import { DEFAULTS, RASTER_DEFAULTS } from "../../src/config/defaults";
import type { RasterPlacement } from "../../src/render/raster/geometry";
import { RasterRefusedError, type RasterProvider } from "../../src/render/raster/provider";
import type { RasterFrameStats } from "../../src/render/raster/renderer";
import { percentile } from "../lib/stats";
import { RASTER_EDGES, RASTER_VARIANTS, type RasterDecodeRow, type RasterFirstDrawing, type RasterFitRun, type RasterReplayRow, type RasterSceneRun, type RasterUploadRow, type RasterVariant } from "../lib/hardware";
import { CSS_H, CSS_W, LAT_PER_PX, LON_PER_PX, CENTER, build, frames, stats, type Rig } from "./layer-page";

// Page side of the raster run (#108). Four parts, all in one page: the decode table (the shipped decode worker, one tile per codec
// variant and tile size), the texImage2D table, the wired layer on a real MapLibre map with the 1e6-segment stroke scene plus one and
// plus ten A0 scans at 400 dpi (panning and zooming so levels change and decodes run), a two-scan view at 1080p and 4K device pixels
// against the gpu ceiling, and the first drawing with a raster over a paced link. The tiles are the pinned ones of
// bench/hw/raster-tiles.json, served by the run's own loopback server.
const A0 = { width: 18724, height: 13244 };
const EDGE = 512;
const GPU_CEILING = 128 * 1024 * 1024;
const POLYLINES = 10;

const FORMAT: Record<RasterVariant, { codec: 1 | 2 | 3; channels: 1 | 3 | 4; bitDepth: 1 | 8; file: (edge: number) => string }> = {
  "png-gray1": { codec: 1, channels: 1, bitDepth: 1, file: (e) => `png-gray1-${e}.png` },
  "png-gray8": { codec: 1, channels: 1, bitDepth: 8, file: (e) => `png-gray8-${e}.png` },
  "png-rgba": { codec: 1, channels: 4, bitDepth: 8, file: (e) => `png-rgba-${e}.png` },
  "jpeg-gray": { codec: 2, channels: 1, bitDepth: 8, file: (e) => `jpeg-gray-${e}.jpg` },
  "jpeg-rgb": { codec: 2, channels: 3, bitDepth: 8, file: (e) => `jpeg-rgb-${e}.jpg` },
  "webp-vp8l": { codec: 3, channels: 4, bitDepth: 8, file: (e) => `webp-vp8l-${e}.webp` },
};
const MIME = { 1: "image/png", 2: "image/jpeg", 3: "image/webp" } as const;
/** What the scans are made of, in raster order: mostly gray scans and a photo or two, as a plan set would be. */
const SCAN_VARIANTS: RasterVariant[] = ["jpeg-gray", "png-gray8", "png-gray1", "jpeg-rgb", "webp-vp8l", "png-rgba"];

(globalThis as { __RPROF?: Record<string, number> }).__RPROF = {};
const counters = { mainDecodes: 0 };
const origBitmap = window.createImageBitmap.bind(window);
window.createImageBitmap = ((...a: Parameters<typeof createImageBitmap>) => (counters.mainDecodes++, origBitmap(...a))) as typeof createImageBitmap;
const origImageDecode = HTMLImageElement.prototype.decode;
HTMLImageElement.prototype.decode = function (this: HTMLImageElement) { counters.mainDecodes++; return origImageDecode.call(this); };

const cache = new Map<string, Uint8Array>();
async function tileBytes(variant: RasterVariant, edge: number): Promise<Uint8Array> {
  const f = FORMAT[variant].file(edge);
  let b = cache.get(f);
  if (!b) cache.set(f, (b = new Uint8Array(await (await fetch(`/tiles/${f}`)).arrayBuffer())));
  return b;
}

const levelsFor = (w: number, h: number, edge: number): number => Math.max(1, Math.ceil(Math.log2(Math.max(w, h) / edge)) + 1);
const grid = (p: RasterPlacement, level: number): [number, number] => {
  const scale = 2 ** (p.levels - 1 - level);
  return [Math.ceil(Math.ceil(p.width / scale) / p.tileEdge), Math.ceil(Math.ceil(p.height / scale) / p.tileEdge)];
};

/** Placement k: an A0 scan, `s` source units per pixel, y up, turned a little more for every scan so the matrix chain is not trivial. */
function placement(k: number, s: number, at: [number, number]): RasterPlacement {
  const v = FORMAT[SCAN_VARIANTS[k % SCAN_VARIANTS.length]!];
  const a = (k * 0.4 * Math.PI) / 180, c = Math.cos(a), si = Math.sin(a);
  // pixel (x, y), y down, to source: scale, flip, turn around the scan's centre, then move the centre to `at`.
  const cx = A0.width / 2, cy = A0.height / 2;
  const m = [s * c, s * si, s * si, -s * c] as const;
  const tx = at[0] - (m[0] * cx + m[1] * cy), ty = at[1] - (m[2] * cx + m[3] * cy);
  return {
    id: k, pixelToSource: [m[0], m[1], m[2], m[3], tx, ty], width: A0.width, height: A0.height, visibleBox: [0, 0, A0.width, A0.height],
    tileEdge: EDGE, levels: levelsFor(A0.width, A0.height, EDGE), codec: v.codec, channels: v.channels, bitDepth: v.bitDepth, opacity: 255, band: k % 2 === 0 ? 0 : 1,
  };
}

function provider(ps: RasterPlacement[], net?: { mbit: number; fetched: { bytes: number } }): RasterProvider {
  return {
    placements: () => ps,
    tile: async (id, level, col, row) => {
      const p = ps[id];
      if (!p) throw new RasterRefusedError("RASTER-01", `no raster ${id}`);
      const [cols, rows] = grid(p, level);
      if (col >= cols || row >= rows) return null;
      const variant = SCAN_VARIANTS[id % SCAN_VARIANTS.length]!;
      if (net) {
        const b = new Uint8Array(await (await fetch(`/net/${net.mbit}/${FORMAT[variant].file(p.tileEdge)}`, { cache: "no-store" })).arrayBuffer());
        net.fetched.bytes += b.length;
        return b;
      }
      return (await tileBytes(variant, p.tileEdge)).slice();
    },
  };
}

async function decodeTable(): Promise<RasterDecodeRow[]> {
  const rows: RasterDecodeRow[] = [];
  for (const variant of RASTER_VARIANTS) {
    for (const edge of RASTER_EDGES) {
      const bytes = await tileBytes(variant, edge);
      const mime = MIME[FORMAT[variant].codec];
      const w = spawnDecodeWorker();
      let n = 0;
      const one = () => new Promise<number>((resolve, reject) => {
        const copy = bytes.slice();
        const id = ++n;
        w.onmessage = (e) => {
          const d = e.data;
          if ("error" in d) reject(new Error(`${variant} ${edge}: ${d.error}`));
          else (d.bitmap.close(), resolve(d.ms));
        };
        w.postMessage({ id, bytes: copy.buffer, mime }, [copy.buffer]);
      });
      const cold = await one();
      const samples = edge === 1024 ? 12 : edge === 512 ? 20 : 30;
      const ms: number[] = [];
      for (let i = 0; i < samples; i++) ms.push(await one());
      w.terminate();
      rows.push({ variant, edge, samples, bytes: bytes.length, coldMs: cold, p50Ms: percentile(ms, 50), p95Ms: percentile(ms, 95) });
    }
  }
  return rows;
}

async function uploadTable(): Promise<RasterUploadRow[]> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 16;
  const gl = canvas.getContext("webgl2")!;
  const rows: RasterUploadRow[] = [];
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const edge of RASTER_EDGES) {
    const bytes = await tileBytes("png-rgba", edge);
    const bitmap = await origBitmap(new Blob([bytes.slice()], { type: "image/png" }), { colorSpaceConversion: "none", imageOrientation: "none", premultiplyAlpha: "premultiply" });
    const t: number[] = [];
    for (let i = -3; i < 25; i++) {
      const s = performance.now();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.finish();
      if (i >= 0) t.push(performance.now() - s);
    }
    // The same bitmap into immutable storage, to see whether re-specifying a texture is part of the cost.
    const sub = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sub);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, bitmap.width, bitmap.height);
    const u: number[] = [];
    for (let i = -3; i < 25; i++) {
      const s = performance.now();
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.finish();
      if (i >= 0) u.push(performance.now() - s);
    }
    gl.deleteTexture(sub);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    bitmap.close();
    rows.push({ edge, samples: t.length, p50Ms: percentile(t, 50), p95Ms: percentile(t, 95), subP50Ms: percentile(u, 50), subP95Ms: percentile(u, 95) });
  }
  gl.deleteTexture(tex);
  return rows;
}

/** `uploads` has one entry per frame that uploaded a tile, from the layer's first frame on (the fill after `addLayer` included). */
interface Watch { last: RasterFrameStats | undefined; peakTextures: number; peakTextureBytes: number; uploads: { tiles: number; bytes: number }[] }
const watch = (): Watch => ({ last: undefined, peakTextures: 0, peakTextureBytes: 0, uploads: [] });
const seen = (w: Watch, st: RasterFrameStats) => { w.last = st; w.peakTextures = Math.max(w.peakTextures, st.textures); w.peakTextureBytes = Math.max(w.peakTextureBytes, st.textureBytes); if (st.uploads) w.uploads.push({ tiles: st.uploads, bytes: st.uploadedBytes }); };

/** A run of the wired layer with rasters: `scans` A0 scans over the stroke scene (when `strokes`), the map panned and zoomed every frame. */
async function scene(name: "strokes+0" | "strokes+1" | "strokes+10", scans: number, o: { durationMs: number; warmupMs: number; diffFrames: number; profile?: boolean }): Promise<RasterSceneRun> {
  const mk = (): { ps: RasterPlacement[]; w: Watch; extra: Parameters<typeof build>[1] } => {
    // Fit to the map: a scan spans 90 percent of the width, the scans are staggered a little so they do not coincide.
    const s = (CSS_W * 0.9) / A0.width;
    const ps = Array.from({ length: scans }, (_, k) => placement(k, s, [CSS_W / 2 + k * 6, CSS_H / 2 + k * 4]));
    const w = watch();
    return { ps, w, extra: { openRasters: async () => provider(ps), onRasterFrame: (st: RasterFrameStats) => seen(w, st) } };
  };
  counters.mainDecodes = 0;
  const m = mk();
  const rig = await build(false, m.extra);
  const { map, layer, gl } = rig;

  let lastRenderMs = 0, lastCalls = 0, calls = 0;
  const orig = gl.drawArraysInstanced.bind(gl);
  gl.drawArraysInstanced = ((...a: Parameters<typeof orig>) => { calls++; return orig(...a); }) as typeof orig;
  // --profile: JavaScript time and call counts per GL entry point inside layer.render, to see where a frame's CPU goes.
  const glTime = new Map<string, { n: number; ms: number }>();
  let inRender = false;
  if (o.profile) {
    for (const fname of Object.getOwnPropertyNames(WebGL2RenderingContext.prototype)) {
      const fn = (gl as unknown as Record<string, unknown>)[fname];
      if (typeof fn !== "function" || fname === "constructor") continue;
      (gl as unknown as Record<string, unknown>)[fname] = (...a: unknown[]) => {
        if (!inRender) return (fn as (...x: unknown[]) => unknown).apply(gl, a);
        const t = performance.now();
        const r = (fn as (...x: unknown[]) => unknown).apply(gl, a);
        const e = glTime.get(fname) ?? { n: 0, ms: 0 };
        e.n++; e.ms += performance.now() - t; glTime.set(fname, e);
        return r;
      };
    }
  }
  const prepareMs: number[] = [];
  const inner = layer.render.bind(layer);
  layer.render = (g, args) => {
    const before = calls;
    const s = performance.now();
    inRender = true;
    inner(g, args);
    inRender = false;
    if (m.w.last) prepareMs.push(m.w.last.renderMs);
    lastRenderMs = performance.now() - s;
    lastCalls = calls - before;
  };

  map.addLayer(layer as never);
  // Settle: the strokes uploaded and drawn (ten calls) and no raster tile pending, for three frames in a row.
  let quiet = 0;
  const settling = frames(rig, undefined, 240_000, () => {
    const st = m.w.last;
    const ok = lastCalls >= POLYLINES && (scans === 0 || (!!st && st.pending === 0 && st.decodesInFlight === 0 && st.textures > 0));
    quiet = ok ? quiet + 1 : 0;
    return quiet >= 3;
  });
  await layer.whenReady();
  await settling;

  const interval: number[] = [], render: number[] = [], steadyMs: number[] = [], uploadMs: number[] = [];
  let peakTier = 0, last = 0, start = 0, i = 0;
  const budget = DEFAULTS.uploadBudgetBytes, tile = EDGE * EDGE * RASTER_DEFAULTS.bytesPerTexel;
  await new Promise<void>((resolve) => {
    const step = () => {
      const ts = performance.now();
      if (!start) start = ts;
      if (ts - start >= o.warmupMs) {
        if (last) {
          interval.push(ts - last);
          render.push(lastRenderMs);
          (m.w.last && m.w.last.uploads > 0 ? uploadMs : steadyMs).push(lastRenderMs);
          peakTier = Math.max(peakTier, layer.getDiagnostics().bytes.gpuTier);
        }
        last = ts;
      }
      i++;
      if (ts - start >= o.warmupMs + o.durationMs + 1000) { map.off("render", step); resolve(); return; }
      // Pan side to side and breathe the zoom by 0.8 of a level, so the level rule moves and tiles keep arriving.
      map.setCenter([CENTER[0] + Math.sin(i / 90) * 500 * LON_PER_PX, CENTER[1] + Math.cos(i / 130) * 250 * LAT_PER_PX]);
      map.setZoom(17 + 0.8 * Math.sin(i / 300));
      map.triggerRepaint();
    };
    map.on("render", step);
    map.triggerRepaint();
  });
  const recordedMs = interval.reduce((a, b) => a + b, 0);
  const errors = rig.errors();
  const mainThreadDecodes = counters.mainDecodes;
  map.remove();

  // The guard's debug diff gets its own short run with the same scene.
  const d = mk();
  const dbg = await build(true, d.extra);
  dbg.map.addLayer(dbg.layer as never);
  await dbg.layer.whenReady();
  await frames(dbg, o.diffFrames, 0, (j) => { dbg.map.setZoom(17 + 0.6 * Math.sin(j / 40)); });
  const stateDiffs = dbg.diffs();
  const errorsDebug = dbg.errors();
  dbg.map.remove();

  const fs = stats(interval), rs = stats(render);
  const part = (v: number[]) => (v.length ? stats(v) : { p50: 0, p95: 0, p99: 0, max: 0 });
  const ss = part(steadyMs), us = part(uploadMs);
  const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
  return {
    name, rasters: scans, durationMs: Math.round(recordedMs), segments: POLYLINES * 100_000,
    frames: { count: interval.length, p50Ms: fs.p50, p95Ms: fs.p95, p99Ms: fs.p99, maxMs: fs.max, over20Ms: interval.filter((v) => v > 20).length },
    render: {
      p50Ms: rs.p50, p95Ms: rs.p95, maxMs: rs.max,
      steady: { frames: steadyMs.length, meanMs: mean(steadyMs), p50Ms: ss.p50, p95Ms: ss.p95, p99Ms: ss.p99, maxMs: ss.max, over16_7Ms: steadyMs.filter((v) => v > 16.7) },
      uploadFrames: { frames: uploadMs.length, share: render.length ? uploadMs.length / render.length : 0, p50Ms: us.p50, p95Ms: us.p95, maxMs: us.max, over16_7Ms: uploadMs.filter((v) => v > 16.7) },
    },
    uploads: {
      framesWithUploads: m.w.uploads.length, maxTilesPerFrame: Math.max(0, ...m.w.uploads.map((u) => u.tiles)), maxBytesPerFrame: Math.max(0, ...m.w.uploads.map((u) => u.bytes)),
      overBudgetFrames: m.w.uploads.filter((u) => u.bytes >= budget + tile).length,
    },
    texture: { peakTextures: m.w.peakTextures, peakGpuTierBytes: Math.max(peakTier, m.w.peakTextureBytes), gpuBytes: GPU_CEILING },
    stateDiffs, errors: errors + errorsDebug, mainThreadDecodes,
    phases: { ...(globalThis as { __RPROF?: Record<string, number> }).__RPROF },
    ...(o.profile ? { profile: { phases: { ...(globalThis as { __RPROF?: Record<string, number> }).__RPROF }, prepareP50Ms: stats(prepareMs).p50, prepareP95Ms: stats(prepareMs).p95, gl: [...glTime].map(([name, v]) => ({ name, calls: v.n, ms: v.ms })).sort((x, y) => y.ms - x.ms).slice(0, 12), renders: render.length } } : {}),
  };
}

/** Two A0 scans seen at one raster pixel per device pixel, in a map of `deviceW` by `deviceH` device pixels: the view that holds the most tiles. */
async function fit(view: "1080p" | "4k", deviceW: number, deviceH: number): Promise<RasterFitRun> {
  const dpr = devicePixelRatio;
  const w = deviceW / dpr, h = deviceH / dpr;
  const s = 1 / dpr; // source units per scan pixel: one source unit is one css px at zoom 17
  const ps = [0, 1].map((k) => placement(k, s, [w / 2 + k * 40, h / 2 + k * 25]));
  const watcher = watch();
  const rig: Rig = await build(false, { openRasters: async () => provider(ps), onRasterFrame: (st) => seen(watcher, st) }, { w, h, strokes: false });
  rig.map.addLayer(rig.layer as never);
  let quiet = 0, peakTier = 0;
  await rig.layer.whenReady();
  await frames(rig, undefined, 240_000, () => {
    const st = watcher.last;
    peakTier = Math.max(peakTier, rig.layer.getDiagnostics().bytes.gpuTier);
    quiet = st && st.pending === 0 && st.decodesInFlight === 0 && st.textures > 0 ? quiet + 1 : 0;
    return quiet >= 5;
  });
  const levels = watcher.last?.levels ?? [];
  const result: RasterFitRun = { view, deviceSize: [deviceW, deviceH], rasters: 2, gpuBytes: GPU_CEILING, peakGpuTierBytes: Math.max(peakTier, watcher.peakTextureBytes), textures: watcher.peakTextures, levels };
  rig.map.remove();
  return result;
}

/** From addLayer to the first frame that draws a raster, one scan, tiles fetched from the origin paced to `mbit`. */
async function firstDrawing(mbit: number): Promise<RasterFirstDrawing> {
  const fetched = { bytes: 0 };
  const ps = [placement(0, (CSS_W * 0.9) / A0.width, [CSS_W / 2, CSS_H / 2])];
  const w = watch();
  const rig = await build(false, { openRasters: async () => provider(ps, { mbit, fetched }), onRasterFrame: (st) => seen(w, st) }, { w: CSS_W, h: CSS_H, strokes: false });
  const t0 = performance.now();
  rig.map.addLayer(rig.layer as never);
  let ms = 0;
  await frames(rig, undefined, 60_000, (_i, ts) => {
    if (w.last && w.last.levels.length > 0) { ms = ts - t0; return true; }
    return false;
  });
  rig.map.remove();
  return { mbit, ms, bytes: fetched.bytes };
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;

/**
 * A corpus raster case through the layer, rasters on and off: 1e5 segments from the stand-in cursor, the case's scans, a viewport
 * script of five zoom steps and a ring of pan steps (the shape of bench/lib/viewport.ts around this scene's native zoom 17).
 * First drawing is addLayer to the first frame that drew the strokes (and, with rasters on, a raster); frames are the render intervals.
 */
async function replay(id: string, scans: number, on: boolean, runs: number): Promise<RasterReplayRow> {
  const first: number[] = [], p95: number[] = [], max: number[] = [];
  let count = 0;
  for (let r = 0; r < runs; r++) {
    const s = (CSS_W * 0.9) / A0.width;
    const ps = Array.from({ length: scans }, (_, k) => placement(k, s, [CSS_W / 2 + k * 6, CSS_H / 2 + k * 4]));
    const w = watch();
    let calls = 0, lastCalls = 0;
    const rig = await build(false, { openRasters: async () => provider(ps), onRasterFrame: (st) => seen(w, st) }, { w: CSS_W, h: CSS_H, segPerLine: 10_000 });
    if (!on) rig.layer.update({ raster: { enabled: false } });
    const gl = rig.gl;
    const orig = gl.drawArraysInstanced.bind(gl);
    gl.drawArraysInstanced = ((...a: Parameters<typeof orig>) => { calls++; return orig(...a); }) as typeof orig;
    const inner = rig.layer.render.bind(rig.layer);
    rig.layer.render = (g, args) => { const b = calls; inner(g, args); lastCalls = calls - b; };
    const t0 = performance.now();
    rig.map.addLayer(rig.layer as never);
    let drawnAt = 0, i = 0, last = 0, recording = false;
    const intervals: number[] = [];
    await new Promise<void>((resolve) => {
      const step = () => {
        const ts = performance.now();
        if (!drawnAt && lastCalls >= POLYLINES && (!on || (w.last?.levels.length ?? 0) > 0)) { drawnAt = ts - t0; recording = true; }
        // A scene that never draws everything (software GL) still gets its replay, with the first drawing recorded as the cap.
        else if (!drawnAt && ts - t0 > 120_000) { drawnAt = ts - t0; recording = true; }
        if (recording) { if (last) intervals.push(ts - last); last = ts; i++; }
        const k = Math.floor(i / 60);
        if (k >= 5 + 24) { rig.map.off("render", step); resolve(); return; }
        if (recording) {
          if (k < 5) rig.map.setZoom([16, 17, 18, 19, 17][k]!);
          else { const a = ((k - 5) / 24) * 2 * Math.PI; rig.map.setCenter([CENTER[0] + Math.cos(a) * 200 * LON_PER_PX, CENTER[1] + Math.sin(a) * 200 * LAT_PER_PX]); }
        }
        rig.map.triggerRepaint();
      };
      rig.map.on("render", step);
      rig.map.triggerRepaint();
    });
    rig.map.remove();
    first.push(drawnAt); p95.push(stats(intervals).p95); max.push(stats(intervals).max); count = intervals.length;
  }
  return { case: id, rasters: on ? "on" : "off", runs, firstDrawingMs: median(first), p95FrameMs: median(p95), maxFrameMs: median(max), frames: count };
}

/** The smallest positive step of `performance.now` over a burst of readings: 0.1 ms where Chromium coarsens it, 1 ms where WebKit clamps it. */
function timerResolution(): number {
  let best = Infinity;
  for (let i = 0; i < 200_000; i++) {
    const a = performance.now(), b = performance.now();
    if (b > a && b - a < best) best = b - a;
  }
  return Number.isFinite(best) ? Math.round(best * 1000) / 1000 : 0;
}

export async function run(o: { durationMs: number; warmupMs: number; diffFrames: number; profile?: boolean; replay?: boolean }) {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2")!;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const gpuRenderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const gpuVendor = String(info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
  const timerQuery = !!gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const say = (m: string) => console.log(`[raster] ${m} at ${Math.round(performance.now() / 1000)} s`);
  const decode = await decodeTable();
  say("decode table done");
  const upload = await uploadTable();
  say("upload table done");
  const fits = [await fit("1080p", 1920, 1080), await fit("4k", 3840, 2160)];
  say("fit views done");
  const firstDrawings = [await firstDrawing(25), await firstDrawing(5)];
  say("first drawing done");
  const scenes = [await scene("strokes+0", 0, o), await scene("strokes+1", 1, o)];
  say("scene 1 done");
  scenes.push(await scene("strokes+10", 10, o));
  say("scene 10 done");
  const replays: RasterReplayRow[] = [];
  if (o.replay !== false) for (const [id, n] of [["architectural-1e5+1-scan", 1], ["architectural-1e5+10-scans", 10]] as const) for (const on of [true, false]) replays.push(await replay(id, n, on, 3));
  return { gpuRenderer, gpuVendor, timerResolutionMs: timerResolution(), dpr: devicePixelRatio, viewport: [CSS_W, CSS_H] as [number, number], timerQuery, raster: { decode, upload, scenes, fit: fits, firstDrawing: firstDrawings, replay: replays } };
}
