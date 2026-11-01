// A scan converted by libviprs, placed on a real map by a georeference the page supplies. The file carries no map position:
// the calibration below is the only thing that says where it goes. Nothing leaves 127.0.0.1.
import { createPVecLayer } from "/pkg/index.js";
import { calibration, lngLatOf } from "/lib/truth.mjs";
import { frames, lattice, openMap, rastersDrawn, snapshot, until } from "/lib/map.js";

const cal = calibration();
// EPSG:4326 as a plain object: the add-on takes the adapter from you, so no projection library is a dependency.
const crs = { id: "EPSG:4326", forward: (x, y) => [x, y], inverse: (lng, lat) => [lng, lat] };

try {
  const map = await openMap("map", lngLatOf(75, 47.5, cal), 17.5);
  const layer = createPVecLayer({
    id: "scan",
    source: { url: new URL("/fixtures/scan.pvec", location.href).href },
    georeference: { reference: { kind: "affine", unit: "m", calibration: cal.array, crs } },
  });
  const errors = [];
  layer.on("error", (e) => errors.push(e.code));
  window.__layer = layer;
  map.addLayer(layer);
  await layer.whenReady();
  await until(map, rastersDrawn(layer));
  await frames(map, 2);
  const px = snapshot(map);
  window.__result = { errors, rasters: layer.rasters().length, samples: lattice(map).map((p) => ({ ...p, rgba: px(p.cssX, p.cssY) })) };
  document.getElementById("status").dataset.state = errors.length ? "error" : "ready";
  document.getElementById("status").textContent = errors.length ? `failed: ${errors[0]}` : "ready";
} catch (e) {
  window.__failed = String(e && e.stack ? e.stack : e);
}
