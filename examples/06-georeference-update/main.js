// Hot calibration on screen: the drawing is up, then the page hands the layer a new georeference and the scan moves, with no
// new request for the file. Samples are taken before and after at the same screen points.
import { createPVecLayer } from "/pkg/index.js";
import { calibration, lngLatOf } from "/lib/truth.mjs";
import { frames, lattice, openMap, rastersDrawn, snapshot, until } from "/lib/map.js";

const crs = { id: "EPSG:4326", forward: (x, y) => [x, y], inverse: (lng, lat) => [lng, lat] };
const reference = (cal) => ({ kind: "affine", unit: "m", calibration: cal.array, crs });
const before = calibration();
// The new calibration slides the sheet 40 m east and 25 m north of where it was.
const after = calibration({ dLng: 40 * before.kx, dLat: 25 * before.ky });
const fileRequests = () => performance.getEntriesByType("resource").filter((e) => e.name.includes("/fixtures/")).length;

try {
  const map = await openMap("map", lngLatOf(75, 47.5, before), 17.5);
  const layer = createPVecLayer({ id: "scan", source: { url: new URL("/fixtures/scan.pvec", location.href).href }, georeference: { reference: reference(before) } });
  const errors = [];
  layer.on("error", (e) => errors.push(e.code));
  window.__layer = layer;
  map.addLayer(layer);
  await layer.whenReady();
  await until(map, rastersDrawn(layer));
  await frames(map, 2);
  const points = lattice(map);
  const px1 = snapshot(map);
  const first = points.map((p) => ({ ...p, rgba: px1(p.cssX, p.cssY) }));
  const requestsBefore = fileRequests();

  layer.update({ georeference: { reference: reference(after) } });
  await frames(map, 3);
  const px2 = snapshot(map);
  const second = points.map((p) => ({ ...p, rgba: px2(p.cssX, p.cssY) }));

  window.__result = { errors, rasters: layer.rasters().length, first, second, requestsBefore, requestsAfter: fileRequests(), ranges: layer.getDiagnostics().ranges.issued };
  document.getElementById("status").dataset.state = errors.length ? "error" : "ready";
  document.getElementById("status").textContent = errors.length ? `failed: ${errors[0]}` : "ready";
} catch (e) {
  window.__failed = String(e && e.stack ? e.stack : e);
}
