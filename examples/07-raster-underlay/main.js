// A scan under a drawing. The file is pvec's synthetic tiler output (three rasters: a whole pyramid, a sparse one, and one whose codec
// the reader does not know), the layer is the packed package, the evaluator is the shipped module with the raster exports, and the
// decode happens in the layer's own worker. Nothing here leaves the local server.
import { createPVecLayer } from "/pkg/index.js";

const result = { errors: [], skipped: [], rasters: [], attribution: "", drawnPixels: 0, offPixels: 0, diagnostics: null };
const status = document.getElementById("status");
const done = () => {
  status.dataset.state = result.errors.length ? "error" : "ready";
  status.textContent = result.errors.length ? `failed: ${result.errors[0].code}` : "ready";
  document.getElementById("out").textContent = JSON.stringify(result, null, 2);
};

// The file's source space to longitude and latitude: one affine, ten micro-degrees per source unit, the scan centred on the map.
// The CRS adapter is the identity on degrees (EPSG:4326), written inline because the package takes an adapter and ships no projection code.
const crs = { id: "EPSG:4326", forward: (x, y) => [x, y], inverse: (lng, lat) => [lng, lat] };
const reference = { kind: "affine", unit: "m", crs, calibration: [1e-5, 0, 0, 1e-5, 8.54 - 420e-5, 47.37 + 14e-5] };
const BACKGROUND = "#dfe7ee";

const map = new maplibregl.Map({
  container: "map",
  center: [8.54, 47.37],
  zoom: 16.2,
  interactive: false,
  fadeDuration: 0,
  attributionControl: false,
  canvasContextAttributes: { preserveDrawingBuffer: true },
  style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": BACKGROUND } }] },
});

/** Pixels of the map canvas that are not the background colour, read back through a 2D canvas. */
function paintedPixels() {
  const c = map.getCanvas();
  const copy = document.createElement("canvas");
  copy.width = c.width;
  copy.height = c.height;
  const g = copy.getContext("2d");
  g.drawImage(c, 0, 0);
  const d = g.getImageData(0, 0, copy.width, copy.height).data;
  const bg = [0xdf, 0xe7, 0xee];
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 12) n++;
  return n;
}
const frame = () => new Promise((r) => map.once("render", () => r()));

try {
  await new Promise((r) => map.once("load", () => r()));
  const layer = createPVecLayer({
    id: "drawing",
    source: { url: new URL("/fixtures/synthetic.pvec", location.href).href },
    georeference: { reference },
  });
  layer.on("error", (e) => result.errors.push({ code: e.code, message: String(e.message) }));
  layer.on("rasterskipped", (e) => {
    result.skipped.push({ rasterId: e.rasterId, rule: e.rule, message: e.message });
    const li = document.createElement("li");
    li.textContent = `raster ${e.rasterId}: ${e.rule}`;
    document.getElementById("skipped").append(li);
  });
  map.addLayer(layer);
  await layer.whenReady();
  // Draw until the rasters have been decoded and uploaded: the layer asks for a repaint while a tile is in flight.
  for (let i = 0; i < 600 && result.drawnPixels === 0; i++) {
    map.triggerRepaint();
    await frame();
    if (layer.getDiagnostics().rasters.drawn > 0 && layer.getDiagnostics().rasters.decodesInFlight === 0 && i > 5) result.drawnPixels = paintedPixels();
  }
  for (const r of layer.rasters()) {
    result.rasters.push(r);
    const tr = document.createElement("tr");
    for (const v of [r.id, r.band, r.opacity, `${r.width} by ${r.height}`, r.attribution ?? ""]) {
      const td = document.createElement("td");
      td.textContent = String(v);
      tr.append(td);
    }
    document.querySelector("#rasters tbody").append(tr);
  }
  // The attribution comes from rasters(), text only, through MapLibre's own control.
  result.attribution = layer.rasters().map((r) => r.attribution).filter(Boolean).join(" | ");
  if (result.attribution) map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: result.attribution }));
  result.diagnostics = layer.getDiagnostics().rasters;

  const show = document.getElementById("show");
  show.addEventListener("change", () => layer.update({ raster: { enabled: show.checked } }));
  // The toggle, once, so the page proves the off state draws nothing of the rasters.
  layer.update({ raster: { enabled: false } });
  await frame();
  await frame();
  result.offPixels = paintedPixels();
  layer.update({ raster: { enabled: true } });
  map.triggerRepaint();
  await frame();
} catch (e) {
  result.errors.push({ code: e.code ?? e.name, message: String(e.message) });
}
done();
