// Known truth for the circle fixture (circle-001: centre (1.5, -2.25), radius 2.75 source units, KNOWN_TRUTH_EXACT in pvec-gold-fixtures).
// One source unit is 1e-3 degrees of latitude (about 111 m), so the circle is about 300 m across the ground and 4000 px wide at zoom 20.5.
// Nothing here touches the add-on: it is where the picture has to be.
export const CIRCLE = { cx: 1.5, cy: -2.25, r: 2.75 };
const COS_LAT = Math.cos((47.37 * Math.PI) / 180);
export const cal = { kx: 1e-3 / COS_LAT, ky: 1e-3, e: 8.54, f: 47.37 };
export const calibrationArray = [cal.kx, 0, 0, cal.ky, cal.e, cal.f];
export const lngLatOf = (x, y) => [cal.e + cal.kx * x, cal.f + cal.ky * y];
/** The point of the circle at `deg` degrees, as lng/lat. */
export const onCircle = (deg) => lngLatOf(CIRCLE.cx + CIRCLE.r * Math.cos((deg * Math.PI) / 180), CIRCLE.cy + CIRCLE.r * Math.sin((deg * Math.PI) / 180));
