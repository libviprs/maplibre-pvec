// Known truth for the scan fixture (tests/fixtures/pvec-raster/libviprs/scan_under_linework.pvec). The writer paints a 64 by 48
// ramp, value 40 + 3 * column, 100 by 75 source metres at source (25, 10), and the sample for source x is the ramp at
// 0.64 * (x - 25) - 0.5 (pixel centres). The maths below does not touch the add-on: it is what the picture has to look like.
export const PAINTED = { x: 25, y: 10, w: 100, h: 75 };
export const BACKGROUND = [223, 231, 238];
const COS_LAT = Math.cos((47.37 * Math.PI) / 180);

/** Source metres to degrees: 1e-5 degrees of latitude a metre, the same ground distance in longitude. */
export function calibration({ dLng = 0, dLat = 0 } = {}) {
  const kx = 1e-5 / COS_LAT, ky = 1e-5;
  return { kx, ky, e: 8.54 + dLng, f: 47.37 + dLat, array: [kx, 0, 0, ky, 8.54 + dLng, 47.37 + dLat] };
}
/** Source coordinates of a lng/lat under a calibration. */
export const sourceOf = (lng, lat, cal) => [(lng - cal.e) / cal.kx, (lat - cal.f) / cal.ky];
/** The lng/lat of a source point under a calibration. */
export const lngLatOf = (x, y, cal) => [cal.e + cal.kx * x, cal.f + cal.ky * y];

/** Distance in source metres from the painted rectangle's edge, negative inside. */
export const insideBy = (x, y) => Math.min(x - PAINTED.x, PAINTED.x + PAINTED.w - x, y - PAINTED.y, PAINTED.y + PAINTED.h - y);
export const ramp = (x) => 40 + 3 * (0.64 * (x - PAINTED.x) - 0.5);
/** Distance in source metres from the stroke the fixture draws corner to corner of the sheet, over the scan (band 0). */
export function strokeDistance(x, y) {
  const dx = PAINTED.w, dy = PAINTED.h;
  return Math.abs(dy * (x - PAINTED.x) - dx * (y - PAINTED.y)) / Math.hypot(dx, dy);
}
/** The colour a pixel at source (x, y) must have, or undefined within `margin` metres of the edge or of the stroke, where the picture is not the scan alone. */
export function expectedAt(x, y, margin = 6) {
  const d = insideBy(x, y);
  if (Math.abs(d) < margin) return undefined;
  if (d > 0 && strokeDistance(x, y) < margin) return undefined;
  if (d < 0) return BACKGROUND;
  const g = Math.round(ramp(x));
  return [g, g, g];
}
export const near = (got, want, slack = 8) => want.every((v, i) => Math.abs(got[i] - v) <= slack);
