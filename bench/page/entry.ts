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

async function run(script: ViewportScript): Promise<RunReport> {
  const el = document.getElementById("map")!;
  const t0 = performance.now();
  const map = new maplibregl.Map({
    container: el,
    style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#f4f1ea" } }] },
    center: script.start.center,
    zoom: script.start.zoom,
    bearing: script.start.bearing,
    pitch: script.start.pitch,
    fadeDuration: 0,
    canvasContextAttributes: { antialias: true },
  } as maplibregl.MapOptions);
  await new Promise<void>((r) => map.once("idle", () => r()));
  // Baseline "first useful drawing": the first idle frame with the style painted.
  const firstUsefulDrawingMs = performance.now() - t0;

  const gl = map.getCanvas().getContext("webgl2") as WebGL2RenderingContext;
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const gpuRenderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unavailable";

  const frames: number[] = [];
  const step = async (cam: Partial<{ zoom: number; bearing: number; pitch: number; offset: [number, number] }>) => {
    const before = await nextFrame();
    if (cam.offset) map.panBy(cam.offset, { duration: 0 });
    if (cam.zoom !== undefined) map.jumpTo({ zoom: cam.zoom });
    if (cam.bearing !== undefined) map.jumpTo({ bearing: cam.bearing });
    if (cam.pitch !== undefined) map.jumpTo({ pitch: cam.pitch });
    const after = await nextFrame();
    frames.push(after - before);
  };
  for (const z of script.zoomLadder) await step({ zoom: z });
  let prev: [number, number] = [0, 0];
  for (const p of script.panPath) {
    await step({ offset: [p[0] - prev[0], p[1] - prev[1]] });
    prev = p;
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
