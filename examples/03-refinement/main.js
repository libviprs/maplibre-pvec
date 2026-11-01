// The refinement stream on a real map: a circle (known truth) is drawn from its Tier 0 preview, the page zooms in twice, and the layer
// refines the stroke each time the camera has rested, reporting `tier0complete` once and `refinement` with generations that only go up.
// After each refinement 24 points on the analytic circle must have ink under them. Nothing leaves 127.0.0.1.
import { createPVecLayer } from "/pkg/index.js";
import { calibrationArray, lngLatOf, onCircle } from "/lib/circle.mjs";
import { frames, openMap, snapshot, until } from "/lib/map.js";

const crs = { id: "EPSG:4326", forward: (x, y) => [x, y], inverse: (lng, lat) => [lng, lat] };
const ink = (px) => Math.min(px[0], px[1], px[2]) < 160;

/** Screen points of the circle inside the map that have no ink in their 3 by 3 neighbourhood. */
function missing(map) {
  const read = snapshot(map);
  const bad = [];
  let tested = 0;
  for (let deg = 0; deg < 360; deg += 0.5) {
    const p = map.project(onCircle(deg));
    if (!(p.x > 12 && p.x < 628 && p.y > 12 && p.y < 468)) continue;
    tested++;
    let found = false;
    for (let dy = -1; dy <= 1 && !found; dy++) for (let dx = -1; dx <= 1 && !found; dx++) found = ink(read(p.x + dx, p.y + dy));
    if (!found) bad.push([deg, Math.round(p.x), Math.round(p.y)]);
  }
  return { tested, bad };
}

try {
  const center = onCircle(30);
  const map = await openMap("map", lngLatOf(1.5, -2.25), 13);
  const layer = createPVecLayer({
    id: "circle",
    source: { url: new URL("/fixtures/circle.pvec", location.href).href },
    georeference: { reference: { kind: "affine", unit: "m", calibration: calibrationArray, crs } },
  });
  const errors = [];
  const events = [];
  layer.on("error", (e) => errors.push(e.code));
  layer.on("tier0complete", (e) => events.push({ type: "tier0complete", blocksUsed: e.blocksUsed }));
  layer.on("refinement", (e) => events.push({ type: "refinement", ...e }));
  window.__layer = layer;
  map.addLayer(layer);
  await layer.whenReady();
  await until(map, () => events.some((e) => e.type === "tier0complete"));
  const stages = [];
  for (const zoom of [19, 20.5]) {
    const seen = events.filter((e) => e.type === "refinement").length;
    map.jumpTo({ center, zoom });
    await until(map, () => events.filter((e) => e.type === "refinement").length > seen);
    await frames(map, 3);
    stages.push({ zoom, ...missing(map) });
  }
  // Zooming out again makes the stroke finer than it needs to be: nothing is reported.
  const before = events.length;
  map.jumpTo({ center, zoom: 13 });
  await new Promise((r) => setTimeout(r, 1500));
  await frames(map, 2);
  window.__result = { errors, events, stages, afterZoomOut: events.length - before };
  document.getElementById("status").dataset.state = errors.length ? "error" : "ready";
  document.getElementById("status").textContent = errors.length ? `failed: ${errors[0]}` : "ready";
} catch (e) {
  window.__failed = String(e && e.stack ? e.stack : e);
}
