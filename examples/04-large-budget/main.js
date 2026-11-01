// A heap and GPU budget under load. An 8192 by 8192 raster (85 tiles of 1024, four levels, 1-bit gray, written by pvec's seeded tiler)
// with 440 seeded strokes over it is toured at six zooms and places under a 48 MiB GPU tier, with the JS heap watched. Every rendered
// frame's GPU tier is read from the layer's own snapshot. At the deepest zoom the pixels of the raster are held to the pattern the
// tiler paints (lib/rasterTruth.mjs, which does not touch the add-on). Nothing leaves 127.0.0.1.
import { createPVecLayer } from "/pkg/index.js";
import { BG, frames, openMap, snapshot, until } from "/lib/map.js";
import { H, centresIn, expectedBit, lngLatOfPixel, referenceArray } from "/lib/rasterTruth.mjs";

const MiB = 1024 * 1024;
const GPU_BUDGET = 48 * MiB;
const crs = { id: "EPSG:4326", forward: (x, y) => [x, y], inverse: (lng, lat) => [lng, lat] };
const heap = () => performance.memory.usedJSHeapSize;
const collect = () => (typeof gc === "function" ? gc() : undefined);

try {
  const map = await openMap("map", lngLatOfPixel(4096, 4096), 12.5);
  const layer = createPVecLayer({
    id: "big",
    source: { url: new URL("/fixtures/large.pvec", location.href).href },
    cache: { gpuBytes: GPU_BUDGET },
    georeference: { reference: { kind: "affine", unit: "m", calibration: referenceArray(), crs } },
  });
  const errors = [];
  const events = [];
  layer.on("error", (e) => errors.push(e.code));
  layer.on("tier0complete", (e) => events.push({ type: "tier0complete", blocksUsed: e.blocksUsed }));
  layer.on("refinement", (e) => events.push({ type: "refinement", ...e }));
  window.__layer = layer;
  let peakGpu = 0, peakHeap = 0, framesSeen = 0, overBudget = 0;
  map.on("render", () => {
    const d = layer.getDiagnostics();
    framesSeen++;
    peakGpu = Math.max(peakGpu, d.bytes.gpuTier, d.rasters.textureBytes);
    if (d.bytes.gpuTier > GPU_BUDGET || d.rasters.textureBytes > GPU_BUDGET) overBudget++;
    peakHeap = Math.max(peakHeap, heap());
  });
  map.addLayer(layer);
  await layer.whenReady();
  const settled = async () => {
    let calm = 0;
    await until(map, () => {
      const d = layer.getDiagnostics();
      calm = d.rasters.decodesInFlight === 0 && layer.rasters().length > 0 && d.rasters.textureBytes > 0 ? calm + 1 : 0;
      return calm >= 6;
    });
  };
  await settled();
  await until(map, () => events.some((e) => e.type === "tier0complete"));
  collect();
  const baseHeap = heap();

  const tour = [
    { zoom: 12.5, px: [4096, 4096] },
    { zoom: 14, px: [2000, 6000] },
    { zoom: 15.5, px: [6500, 1500] },
    { zoom: 16.8, px: [3000, 3000] },
    { zoom: 14.5, px: [1000, 1000] },
    { zoom: 18, px: [5120, 2560] },
  ];
  const stops = [];
  for (const t of tour) {
    map.jumpTo({ center: lngLatOfPixel(...t.px), zoom: t.zoom });
    await settled();
    await frames(map, 2);
    const read = snapshot(map);
    const d = layer.getDiagnostics();
    // how much of the map shows the raster rather than the page background
    let painted = 0, total = 0;
    for (let y = 20; y < 480; y += 40) for (let x = 20; x < 640; x += 40) {
      total++;
      const c = read(x, y);
      if (Math.abs(c[0] - 223) + Math.abs(c[1] - 231) + Math.abs(c[2] - 238) > 30) painted++;
    }
    stops.push({ zoom: t.zoom, painted, total, gpuTier: d.bytes.gpuTier, textureBytes: d.rasters.textureBytes });
  }
  // the deepest stop is still up: hold the raster to the tiler's pattern at the centre of raster pixels
  const read = snapshot(map);
  const centres = centresIn(map, 5120, 2560, 120);
  const wrong = [];
  let tested = 0;
  for (const c of centres) {
    const rgb = read(c.x, c.y);
    // a stroke can cross a pixel centre: only a gray (r = g = b) black or white pixel is compared
    if (rgb[0] !== rgb[1] || rgb[1] !== rgb[2] || (rgb[0] > 40 && rgb[0] < 215)) continue;
    tested++;
    const want = expectedBit(c.px, c.py) ? 255 : 0;
    if ((rgb[0] > 127 ? 255 : 0) !== want) wrong.push([c.px, c.py, rgb[0], want]);
  }
  collect();
  const endHeap = heap();
  window.__result = {
    errors, events, stops, gpuBudget: GPU_BUDGET, peakGpu, overBudget, framesSeen,
    heap: { base: baseHeap, end: endHeap, peak: peakHeap },
    pattern: { tested, wrong: wrong.slice(0, 5), wrongCount: wrong.length },
    diagnostics: layer.getDiagnostics(), bg: BG,
  };
  document.getElementById("status").dataset.state = errors.length ? "error" : "ready";
  document.getElementById("status").textContent = errors.length ? `failed: ${errors[0]}` : "ready";
} catch (e) {
  window.__failed = String(e && e.stack ? e.stack : e);
}
