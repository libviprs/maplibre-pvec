import maplibregl from "maplibre-gl";
import type { ViewportScript } from "../lib/viewport";

// Replays a viewport script on a MapLibre map and reports timings. This is the map WITHOUT the
// add-on (the baseline every later benchmark is measured against). Diagnostics counters from
// the add-on do not exist yet, so none are collected here.
export interface RunReport {
  firstUsefulDrawingMs: number;
  frameMs: number[];
  p95FrameMs: number;
  maxFrameMs: number;
  gpuRenderer: string;
  crossOriginIsolated: boolean;
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

// Fixed calibration scene: the add-on does not exist yet, so the baseline map draws a seeded
// synthetic line field. It is there so frames cost enough for run-to-run spread to mean something
// (an empty map renders in about 2 ms, below the noise floor). It is not any corpus case.
function scene(): GeoJSON.FeatureCollection {
  let seed = 0x2545f491;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < 500; i++) {
    const x = (rnd() - 0.5) * 0.02;
    const y = (rnd() - 0.5) * 0.02;
    const coordinates: [number, number][] = [];
    for (let j = 0; j < 24; j++) coordinates.push([x + (rnd() - 0.5) * 0.0004 * j, y + (rnd() - 0.5) * 0.0004 * j]);
    features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } });
  }
  return { type: "FeatureCollection", features };
}

function makeMap(script: ViewportScript): maplibregl.Map {
  const el = document.getElementById("map")!;
  return new maplibregl.Map({
    container: el,
    style: {
      version: 8,
      sources: { field: { type: "geojson", data: scene() } },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#f4f1ea" } },
        { id: "field", type: "line", source: "field", paint: { "line-color": "#1f4e79", "line-width": 1.5 } },
      ],
    },
    center: script.start.center,
    zoom: script.start.zoom,
    bearing: script.start.bearing,
    pitch: script.start.pitch,
    fadeDuration: 0,
    canvasContextAttributes: { antialias: true },
  } as maplibregl.MapOptions);
}

async function firstDrawing(script: ViewportScript): Promise<number> {
  const t0 = performance.now();
  const map = makeMap(script);
  await new Promise<void>((r) => map.once("idle", () => r()));
  // Baseline "first useful drawing": the first idle frame with the style painted.
  const ms = performance.now() - t0;
  map.remove();
  return ms;
}

async function run(script: ViewportScript): Promise<RunReport> {
  // One run takes the median of three constructions: a single sub-50 ms sample is mostly jitter.
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) samples.push(await firstDrawing(script));
  const firstUsefulDrawingMs = [...samples].sort((a, b) => a - b)[1]!;

  const map = makeMap(script);
  await new Promise<void>((r) => map.once("idle", () => r()));
  // Time of each MapLibre render pass plus a one-pixel readPixels, so the software rasteriser's work is
  // inside the number (the pass alone is about 2 ms and mostly jitter). This is not the GPU
  // time query, which stays "unavailable" here. _render is private; the version is pinned
  // (4.7.1) and a requestAnimationFrame gap would only show vsync (16.7 ms).
  const gl = map.getCanvas().getContext("webgl2") as WebGL2RenderingContext;
  const m = map as unknown as { _render: (t: number) => unknown };
  const orig = m._render.bind(map);
  const frames: number[] = [];
  const sync = new Uint8Array(4);
  m._render = (t: number) => {
    const s = performance.now();
    const r = orig(t);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, sync); // blocks until the rasteriser is done
    frames.push(performance.now() - s);
    return r;
  };

  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const gpuRenderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unavailable";

  const step = async (cam: Partial<{ zoom: number; bearing: number; pitch: number; offset: [number, number] }>) => {
    await nextFrame();
    if (cam.offset) map.panBy(cam.offset, { duration: 0 });
    if (cam.zoom !== undefined) map.jumpTo({ zoom: cam.zoom });
    if (cam.bearing !== undefined) map.jumpTo({ bearing: cam.bearing });
    if (cam.pitch !== undefined) map.jumpTo({ pitch: cam.pitch });
    await nextFrame();
    // Settle before the next move so every step contributes the same renders in every run.
    await new Promise<void>((r) => (map.loaded() && !map.isMoving() ? r() : map.once("idle", () => r())));
  };
  for (const z of script.zoomLadder) await step({ zoom: z });
  // Three laps of the pan path: p95 over twenty-odd frames is decided by one or two frames.
  let prev: [number, number] = [0, 0];
  for (let lap = 0; lap < 3; lap++) {
    for (const p of script.panPath) {
      await step({ offset: [p[0] - prev[0], p[1] - prev[1]] });
      prev = p;
    }
  }
  for (const b of script.bearingSteps) await step({ bearing: b });
  for (const p of script.pitchSteps) await step({ pitch: p });
  map.remove();

  const sorted = [...frames].sort((a, b) => a - b);
  return {
    firstUsefulDrawingMs,
    frameMs: frames,
    p95FrameMs: sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!,
    maxFrameMs: sorted[sorted.length - 1]!,
    gpuRenderer,
    crossOriginIsolated: window.crossOriginIsolated,
  };
}

(window as unknown as { benchRun: typeof run }).benchRun = run;
