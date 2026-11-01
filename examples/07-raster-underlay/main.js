// A scan under (or over) a drawing. Three files, all served by this page's own server:
//   under  libviprs's conversion of a PDF with a scanned underlay: one raster in band 0, and the linework as a stroke entity
//   over   the same scan in band 1, painted after the stroke
//   mixed  pvec's synthetic tiler output: three rasters, the third with a codec the reader does not know (one rasterskipped)
// The layer is the packed package, the evaluator is the shipped module with the raster exports, and decode happens in the layer's own
// worker. The band and the opacity are the file's; the page shows them from layer.rasters() and can switch the rasters off and on.
import { createPVecLayer } from "/pkg/index.js";

const FILES = {
  // the scan is painted 100 by 75 at source (25, 10); the stroke runs corner to corner
  under: { url: "/fixtures/under.pvec", origin: [75, 47.5], zoom: 18.6, calibration: (o) => [1e-5, 0, 0, 1e-5, 8.54 - o[0] * 1e-5, 47.37 - o[1] * 1e-5] },
  over: { url: "/fixtures/over.pvec", origin: [75, 47.5], zoom: 18.6, calibration: (o) => [1e-5, 0, 0, 1e-5, 8.54 - o[0] * 1e-5, 47.37 - o[1] * 1e-5] },
  mixed: { url: "/fixtures/synthetic.pvec", origin: [420, -14], zoom: 16.2, calibration: (o) => [1e-5, 0, 0, 1e-5, 8.54 - o[0] * 1e-5, 47.37 - o[1] * 1e-5] },
};
// The CRS adapter is the identity on degrees (EPSG:4326), written inline because the package takes an adapter and ships no projection code.
const crs = { id: "EPSG:4326", forward: (x, y) => [x, y], inverse: (lng, lat) => [lng, lat] };

const result = { errors: [], cases: {}, offPixels: 0 };
const status = document.getElementById("status");
const done = () => {
  status.dataset.state = result.errors.length ? "error" : "ready";
  status.textContent = result.errors.length ? `failed: ${result.errors[0].code}` : "ready";
  document.getElementById("out").textContent = JSON.stringify(result, null, 2);
};

const map = new maplibregl.Map({
  container: "map",
  center: [8.54, 47.37],
  zoom: 18.6,
  interactive: false,
  fadeDuration: 0,
  attributionControl: false,
  canvasContextAttributes: { preserveDrawingBuffer: true },
  style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#dfe7ee" } }] },
});
let attribution;
const frame = () => new Promise((r) => (map.once("render", () => r()), map.triggerRepaint()));

/** The map canvas read back through a 2D canvas: the pixels that are not the background colour, and the pixel at a device point. */
function canvasPixels(at) {
  const c = map.getCanvas();
  const copy = document.createElement("canvas");
  copy.width = c.width;
  copy.height = c.height;
  const g = copy.getContext("2d");
  g.drawImage(c, 0, 0);
  const d = g.getImageData(0, 0, copy.width, copy.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 0xdf) + Math.abs(d[i + 1] - 0xe7) + Math.abs(d[i + 2] - 0xee) > 12) n++;
  const x = Math.round(at.x * (c.width / c.clientWidth)), y = Math.round(at.y * (c.height / c.clientHeight));
  const p = (y * copy.width + x) * 4;
  return { painted: n, pixel: [d[p], d[p + 1], d[p + 2]] };
}

let layer;
async function open(key) {
  console.log(`[ex07] open ${key} at ${Math.round(performance.now())} ms`);
  if (layer) map.removeLayer(layer.id);
  if (attribution) (map.removeControl(attribution), (attribution = undefined));
  const f = FILES[key];
  const reference = { kind: "affine", unit: "m", crs, calibration: f.calibration(f.origin) };
  map.jumpTo({ center: [8.54, 47.37], zoom: f.zoom });
  const skipped = [];
  layer = createPVecLayer({ id: `drawing-${key}`, source: { url: new URL(f.url, location.href).href }, georeference: { reference } });
  layer.on("error", (e) => result.errors.push({ code: e.code, message: String(e.message) }));
  layer.on("rasterskipped", (e) => skipped.push({ rasterId: e.rasterId, rule: e.rule, message: e.message }));
  map.addLayer(layer);
  await layer.whenReady();
  let painted = { painted: 0, pixel: [0, 0, 0] };
  const centre = map.project([8.54, 47.37]);
  // Draw until the scan has been decoded and uploaded, then for 6 seconds more: the file's linework (its Tier 0 stream) arrives in steps.
  let ready = -1, readyAt = 0;
  for (let i = 0; i < 600; i++) {
    map.triggerRepaint();
    await frame();
    const d = layer.getDiagnostics().rasters;
    if (ready < 0 && i > 5 && d.drawn > 0 && d.decodesInFlight === 0) (ready = i, (readyAt = performance.now()));
    if (ready >= 0 && performance.now() - readyAt > 6000) break;
  }
  painted = canvasPixels(centre);
  console.log(`[ex07] ${key} read at ${Math.round(performance.now())} ms, ready frame ${ready}`);
  const rasters = layer.rasters();
  const tbody = document.querySelector("#rasters tbody");
  const ul = document.getElementById("skipped");
  tbody.replaceChildren();
  ul.replaceChildren();
  for (const r of rasters) {
    const tr = document.createElement("tr");
    for (const v of [r.id, r.band, r.opacity, `${r.width} by ${r.height}`, r.attribution ?? ""]) {
      const td = document.createElement("td");
      td.textContent = String(v);
      tr.append(td);
    }
    tbody.append(tr);
  }
  for (const e of skipped) {
    const li = document.createElement("li");
    li.textContent = `raster ${e.rasterId}: ${e.rule}`;
    ul.append(li);
  }
  // The attribution comes from rasters(), escaped text, through MapLibre's own control.
  const text = rasters.map((r) => r.attribution).filter(Boolean).join(" | ");
  if (text) map.addControl((attribution = new maplibregl.AttributionControl({ compact: false, customAttribution: text })));
  result.cases[key] = { rasters, skipped, attribution: text, painted: painted.painted, centrePixel: painted.pixel, diagnostics: layer.getDiagnostics().rasters };
}

try {
  await new Promise((r) => map.once("load", () => r()));
  for (const key of ["under", "over", "mixed"]) await open(key);
  // The toggle, once, so the page proves the off state paints less of the rasters than the on state.
  layer.update({ raster: { enabled: false } });
  await frame();
  await frame();
  result.offPixels = canvasPixels(map.project([8.54, 47.37])).painted;
  layer.update({ raster: { enabled: true } });
  map.triggerRepaint();
  await frame();
  for (const input of document.querySelectorAll('input[name="file"]')) input.addEventListener("change", () => input.checked && open(input.value));
  const show = document.getElementById("show");
  show.addEventListener("change", () => layer.update({ raster: { enabled: show.checked } }));
} catch (e) {
  result.errors.push({ code: e.code ?? e.name, message: String(e.message) });
}
done();
