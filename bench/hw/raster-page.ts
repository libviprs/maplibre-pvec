import { spawnDecodeWorker } from "../../src/workers/raster_decode";
import { DEFAULTS, RASTER_DEFAULTS } from "../../src/config/defaults";
import type { RasterPlacement } from "../../src/render/raster/geometry";
import { RasterRefusedError, type RasterProvider } from "../../src/render/raster/provider";
import type { RasterFrameStats } from "../../src/render/raster/renderer";
import { percentile } from "../lib/stats";
import { RASTER_EDGES, RASTER_VARIANTS, type RasterDecodeRow, type RasterFirstDrawing, type RasterFitRun, type RasterSceneRun, type RasterUploadRow, type RasterVariant } from "../lib/hardware";
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
    bitmap.close();
    rows.push({ edge, samples: t.length, p50Ms: percentile(t, 50), p95Ms: percentile(t, 95) });
  }
  gl.deleteTexture(tex);
  return rows;
}

interface Watch { last: RasterFrameStats | undefined; peakTextures: number; peakTextureBytes: number }
const watch = (): Watch => ({ last: undefined, peakTextures: 0, peakTextureBytes: 0 });

/** A run of the wired layer with rasters: `scans` A0 scans over the stroke scene (when `strokes`), the map panned and zoomed every frame. */
async function scene(name: "strokes+1" | "strokes+10", scans: number, o: { durationMs: number; warmupMs: number; diffFrames: number }): Promise<RasterSceneRun> {
  const mk = (): { ps: RasterPlacement[]; w: Watch; extra: Parameters<typeof build>[1] } => {
    // Fit to the map: a scan spans 90 percent of the width, the scans are staggered a little so they do not coincide.
    const s = (CSS_W * 0.9) / A0.width;
    const ps = Array.from({ length: scans }, (_, k) => placement(k, s, [CSS_W / 2 + k * 6, CSS_H / 2 + k * 4]));
    const w = watch();
    return { ps, w, extra: { openRasters: async () => provider(ps), onRasterFrame: (st: RasterFrameStats) => { w.last = st; w.peakTextures = Math.max(w.peakTextures, st.textures); w.peakTextureBytes = Math.max(w.peakTextureBytes, st.textureBytes); } } };
  };
  counters.mainDecodes = 0;
  const m = mk();
  const rig = await build(false, m.extra);
  const { map, layer, gl } = rig;

  let lastRenderMs = 0, lastCalls = 0, calls = 0;
  const orig = gl.drawArraysInstanced.bind(gl);
  gl.drawArraysInstanced = ((...a: Parameters<typeof orig>) => { calls++; return orig(...a); }) as typeof orig;
  const inner = layer.render.bind(layer);
  layer.render = (g, args) => {
    const before = calls;
    const s = performance.now();
    inner(g, args);
    lastRenderMs = performance.now() - s;
    lastCalls = calls - before;
  };

  map.addLayer(layer as never);
  // Settle: the strokes uploaded and drawn (ten calls) and no raster tile pending, for three frames in a row.
  let quiet = 0;
  const settling = frames(rig, undefined, 240_000, () => {
    const st = m.w.last;
    const ok = lastCalls >= POLYLINES && !!st && st.pending === 0 && st.decodesInFlight === 0 && st.textures > 0;
    quiet = ok ? quiet + 1 : 0;
    return quiet >= 3;
  });
  await layer.whenReady();
  await settling;

  const interval: number[] = [], render: number[] = [], uploadBytes: number[] = [], uploadTiles: number[] = [];
  let peakTier = 0, last = 0, start = 0, i = 0;
  m.w.peakTextures = 0; m.w.peakTextureBytes = 0;
  const budget = DEFAULTS.uploadBudgetBytes, tile = EDGE * EDGE * RASTER_DEFAULTS.bytesPerTexel;
  await new Promise<void>((resolve) => {
    const step = () => {
      const ts = performance.now();
      if (!start) start = ts;
      if (ts - start >= o.warmupMs) {
        if (last) {
          interval.push(ts - last);
          render.push(lastRenderMs);
          uploadBytes.push(m.w.last?.uploadedBytes ?? 0);
          uploadTiles.push(m.w.last?.uploads ?? 0);
          peakTier = Math.max(peakTier, layer.getDiagnostics().bytes.gpuTier);
        }
        last = ts;
      }
      i++;
      if (ts - start >= o.warmupMs + o.durationMs) { map.off("render", step); resolve(); return; }
      // Pan side to side and breathe the zoom by 0.6 of a level, so the level rule moves and tiles keep arriving.
      map.setCenter([CENTER[0] + Math.sin(i / 90) * 200 * LON_PER_PX, CENTER[1] + Math.cos(i / 130) * 80 * LAT_PER_PX]);
      map.setZoom(17 + 0.6 * Math.sin(i / 240));
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
  return {
    name, rasters: scans, durationMs: Math.round(recordedMs), segments: POLYLINES * 100_000,
    frames: { count: interval.length, p50Ms: fs.p50, p95Ms: fs.p95, p99Ms: fs.p99, maxMs: fs.max, over20Ms: interval.filter((v) => v > 20).length },
    render: { p50Ms: rs.p50, p95Ms: rs.p95, maxMs: rs.max },
    uploads: {
      framesWithUploads: uploadTiles.filter((n) => n > 0).length, maxTilesPerFrame: Math.max(0, ...uploadTiles), maxBytesPerFrame: Math.max(0, ...uploadBytes),
      overBudgetFrames: uploadBytes.filter((b) => b >= budget + tile).length,
    },
    texture: { peakTextures: m.w.peakTextures, peakGpuTierBytes: Math.max(peakTier, m.w.peakTextureBytes), gpuBytes: GPU_CEILING },
    stateDiffs, errors: errors + errorsDebug, mainThreadDecodes,
  };
}

/** Two A0 scans seen at one raster pixel per device pixel, in a map of `deviceW` by `deviceH` device pixels: the view that holds the most tiles. */
async function fit(view: "1080p" | "4k", deviceW: number, deviceH: number): Promise<RasterFitRun> {
  const dpr = devicePixelRatio;
  const w = deviceW / dpr, h = deviceH / dpr;
  const s = 1 / dpr; // source units per scan pixel: one source unit is one css px at zoom 17
  const ps = [0, 1].map((k) => placement(k, s, [w / 2 + k * 40, h / 2 + k * 25]));
  const watcher = watch();
  const rig: Rig = await build(false, { openRasters: async () => provider(ps), onRasterFrame: (st) => { watcher.last = st; watcher.peakTextures = Math.max(watcher.peakTextures, st.textures); watcher.peakTextureBytes = Math.max(watcher.peakTextureBytes, st.textureBytes); } }, { w, h, strokes: false });
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
  const rig = await build(false, { openRasters: async () => provider(ps, { mbit, fetched }), onRasterFrame: (st) => { w.last = st; } }, { w: CSS_W, h: CSS_H, strokes: false });
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

export async function run(o: { durationMs: number; warmupMs: number; diffFrames: number }) {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2")!;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const gpuRenderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const gpuVendor = String(info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
  const timerQuery = !!gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const decode = await decodeTable();
  const upload = await uploadTable();
  const fits = [await fit("1080p", 1920, 1080), await fit("4k", 3840, 2160)];
  const firstDrawings = [await firstDrawing(25), await firstDrawing(5)];
  const scenes = [await scene("strokes+1", 1, o), await scene("strokes+10", 10, o)];
  return { gpuRenderer, gpuVendor, dpr: devicePixelRatio, viewport: [CSS_W, CSS_H] as [number, number], timerQuery, raster: { decode, upload, scenes, fit: fits, firstDrawing: firstDrawings } };
}
