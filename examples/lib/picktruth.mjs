// Known truth for example 05: three pvec known-truth drawings placed side by side, and the distance from a point to each, worked out
// from the authoring parameters in pvec-gold-fixtures (expected.math.json). Nothing here touches the add-on.
export const LINES = [[0, 0, 4, 1], [0, 2, 3, 3.5], [0, 5, 5.5, 4]]; // layer-state-001: the entities 0, 1 and 2
export const CIRCLE = { cx: 1.5, cy: -2.25, r: 2.75 }; // circle-001
export const BEZIER = [[0, 0], [1, 2.5], [3, 2.5], [4, 0]]; // bezier-d3-001, a cubic
/** Where each drawing's source origin sits, in source units of the shared calibration (one unit is 1e-4 degrees of latitude). */
export const ORIGINS = { lines: [-9, -3], circle: [2, 3.5], bezier: [-1.5, 4.5] };
const COS_LAT = Math.cos((47.37 * Math.PI) / 180);
export const K = { kx: 1e-4 / COS_LAT, ky: 1e-4, e: 8.54, f: 47.37 };
export const referenceFor = (name) => [K.kx, 0, 0, K.ky, K.e + K.kx * ORIGINS[name][0], K.f + K.ky * ORIGINS[name][1]];
/** lng/lat of a source point of a drawing. */
export const lngLatOf = (name, x, y) => [K.e + K.kx * (ORIGINS[name][0] + x), K.f + K.ky * (ORIGINS[name][1] + y)];
/** Source coordinates of a lng/lat on a drawing. */
export const sourceOf = (name, lng, lat) => [(lng - K.e) / K.kx - ORIGINS[name][0], (lat - K.f) / K.ky - ORIGINS[name][1]];

export function toSegment(px, py, [ax, ay, bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
export const toCircle = (px, py) => Math.abs(Math.hypot(px - CIRCLE.cx, py - CIRCLE.cy) - CIRCLE.r);
export const bezierAt = (t) => {
  const u = 1 - t;
  return [0, 1].map((k) => u * u * u * BEZIER[0][k] + 3 * u * u * t * BEZIER[1][k] + 3 * u * t * t * BEZIER[2][k] + t * t * t * BEZIER[3][k]);
};
/** Dense sampling of the cubic, 200,000 points: the reference the exact distance is held to. */
export function toBezier(px, py) {
  let best = Infinity;
  for (let i = 0; i <= 200000; i++) {
    const [x, y] = bezierAt(i / 200000);
    best = Math.min(best, Math.hypot(x - px, y - py));
  }
  return best;
}
