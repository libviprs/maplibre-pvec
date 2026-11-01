// Picking on screen. Three of pvec's known-truth drawings (four segments' worth of lines, a circle and a cubic) are three layers on one
// map. The page asks each layer what is under points whose distance to the drawing is known from the maths (lib/picktruth.mjs, which
// does not touch the add-on), asks for the nearest entity, queries regions, and clicks the canvas. Distances are CSS pixels. Nothing
// leaves 127.0.0.1.
import { createPVecLayer } from "/pkg/index.js";
import { BEZIER, CIRCLE, LINES, bezierAt, lngLatOf, referenceFor, toBezier, toCircle, toSegment } from "/lib/picktruth.mjs";
import { frames, openMap } from "/lib/map.js";

const crs = { id: "EPSG:4326", forward: (x, y) => [x, y], inverse: (lng, lat) => [lng, lat] };
const NAMES = ["lines", "circle", "bezier"];
const FILES = { lines: "/fixtures/lines.pvec", circle: "/fixtures/circle.pvec", bezier: "/fixtures/bezier.pvec" };

try {
  const map = await openMap("map", lngLatOf("lines", 5, 3), 18);
  const errors = [];
  const layers = {};
  for (const name of NAMES) {
    const layer = createPVecLayer({ id: name, source: { url: new URL(FILES[name], location.href).href }, georeference: { reference: { kind: "affine", unit: "m", calibration: referenceFor(name), crs } } });
    layer.on("error", (e) => errors.push(`${name}: ${e.code}`));
    layers[name] = layer;
    map.addLayer(layer);
  }
  await Promise.all(NAMES.map((n) => layers[n].whenReady()));
  await frames(map, 3);
  // CSS pixels per source unit, from the map's own projection of two points one unit apart
  const pxu = (() => {
    const a = map.project(lngLatOf("lines", 0, 0)), b = map.project(lngLatOf("lines", 1, 0));
    return Math.hypot(b.x - a.x, b.y - a.y);
  })();
  const at = (name, x, y) => ({ lng: lngLatOf(name, x, y)[0], lat: lngLatOf(name, x, y)[1] });
  const probes = [];
  const rec = (p) => probes.push(p);
  const summary = (hits) => hits.map((h) => ({ id: h.entityId, distancePx: h.distancePx, generation: h.generation, complete: h.complete }));

  // A. 3 px off the middle of the first line: one hit, entity 0, 3 px
  {
    const [ax, ay, bx, by] = LINES[0];
    const len = Math.hypot(bx - ax, by - ay);
    const x = (ax + bx) / 2 - ((by - ay) / len) * (3 / pxu), y = (ay + by) / 2 + ((bx - ax) / len) * (3 / pxu);
    rec({ name: "line 3 px away", got: summary(layers.lines.pickPoint(at("lines", x, y), { tolerancePx: 4 })), want: [{ id: "0", distancePx: toSegment(x, y, LINES[0]) * pxu }] });
  }
  // B. the nearest of three lines to a point between them, whichever the maths says
  {
    const [x, y] = [2, 1.9];
    const d = LINES.map((s) => toSegment(x, y, s));
    const best = d.indexOf(Math.min(...d));
    const n = layers.lines.nearestEntity(at("lines", x, y), 400);
    rec({ name: "nearest of three lines", got: n ? summary([n]) : [], want: [{ id: String(best), distancePx: Math.min(...d) * pxu }] });
  }
  // C. a point far from everything: nothing under it, nothing within 5 px
  {
    const p = at("lines", 8, -1.5);
    rec({ name: "empty space", got: [...summary(layers.lines.pickPoint(p)), ...(layers.lines.nearestEntity(p, 5) ? [1] : [])], want: [] });
  }
  // D. a circle, 5 px outside it
  {
    const a = (40 * Math.PI) / 180, r = CIRCLE.r + 5 / pxu;
    const x = CIRCLE.cx + r * Math.cos(a), y = CIRCLE.cy + r * Math.sin(a);
    rec({ name: "circle 5 px outside", got: summary(layers.circle.pickPoint(at("circle", x, y), { tolerancePx: 6 })), want: [{ id: "0", distancePx: toCircle(x, y) * pxu }] });
  }
  // E. the centre of the circle: not under the stroke, and the nearest entity is the circle at its radius
  {
    const p = at("circle", CIRCLE.cx, CIRCLE.cy);
    const n = layers.circle.nearestEntity(p, 300);
    rec({ name: "circle centre", got: [...summary(layers.circle.pickPoint(p, { tolerancePx: 6 })).map((h) => ({ ...h, under: true })), ...(n ? summary([n]) : [])], want: [{ id: "0", distancePx: CIRCLE.r * pxu }] });
  }
  // F. a cubic, 4 px off its normal at t = 0.3, held to a 200,000 point sampling of the curve
  {
    const [x0, y0] = bezierAt(0.3), [x1, y1] = bezierAt(0.3001);
    const l = Math.hypot(x1 - x0, y1 - y0);
    const x = x0 - ((y1 - y0) / l) * (4 / pxu), y = y0 + ((x1 - x0) / l) * (4 / pxu);
    rec({ name: "cubic 4 px off", got: summary(layers.bezier.pickPoint(at("bezier", x, y), { tolerancePx: 6 })), want: [{ id: "0", distancePx: toBezier(x, y) * pxu }] });
  }
  // G and H. regions in source units: across the first line, and inside its bounds but away from it
  rec({ name: "region across a line", got: layers.lines.queryRegion({ minX: 1.9, minY: 0.4, maxX: 2.1, maxY: 0.6 }).map((h) => h.entityId), want: ["0"] });
  rec({ name: "region in the bounds, off the line", got: layers.lines.queryRegion({ minX: 0.1, minY: 0.8, maxX: 0.3, maxY: 0.95 }).map((h) => h.entityId), want: [] });
  // I. a click on the canvas 2 px outside the circle, answered by the layer under it
  {
    const clicks = [];
    const canvas = map.getCanvas();
    canvas.addEventListener("click", (e) => {
      const r = canvas.getBoundingClientRect();
      const l = map.unproject([e.clientX - r.left, e.clientY - r.top]);
      clicks.push(summary(layers.circle.pickPoint({ lng: l.lng, lat: l.lat }, { tolerancePx: 3 })));
    });
    const a = (200 * Math.PI) / 180, rr = CIRCLE.r + 2 / pxu;
    const x = CIRCLE.cx + rr * Math.cos(a), y = CIRCLE.cy + rr * Math.sin(a);
    const p = map.project(lngLatOf("circle", x, y));
    const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent("click", { clientX: box.left + p.x, clientY: box.top + p.y, bubbles: true }));
    rec({ name: "click 2 px outside the circle", got: clicks[0] ?? [], want: [{ id: "0", distancePx: toCircle(x, y) * pxu }] });
  }
  window.__result = { errors, probes, pxu, ids: NAMES.map((n) => [n, layers[n].getDiagnostics().frames]) };
  document.getElementById("status").dataset.state = errors.length ? "error" : "ready";
  document.getElementById("status").textContent = errors.length ? `failed: ${errors[0]}` : "ready";
} catch (e) {
  window.__failed = String(e && e.stack ? e.stack : e);
}
