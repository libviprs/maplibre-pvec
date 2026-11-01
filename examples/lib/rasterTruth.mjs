// Known truth for the large raster of example 04: pvec's seeded tiler (pvec#251) places its raster one source unit a pixel with y up
// (pixel_to_source = [1 0 0 -1 0 h]) and paints pixel (x, y) of the 1-bit image with 1 when (x / 16 + y / 16) is even or x is a
// multiple of 7 (crates/pvec-testkit/src/tiler.rs). The calibration below puts one source unit at 1e-5 degrees of latitude.
// Nothing here touches the add-on.
export const W = 8192, H = 8192;
const COS_LAT = Math.cos((47.37 * Math.PI) / 180);
export const cal = { kx: 1e-5 / COS_LAT, ky: 1e-5, e: 8.54, f: 47.37 };
export const referenceArray = () => [cal.kx, 0, 0, cal.ky, cal.e, cal.f];
/** lng/lat of the centre of raster pixel (px, py), py counted down from the top of the image. */
export const lngLatOfPixel = (px, py) => [cal.e + cal.kx * (px + 0.5), cal.f + cal.ky * (H - (py + 0.5))];
export const expectedBit = (px, py) => (Math.floor(px / 16) + Math.floor(py / 16)) % 2 === 0 || px % 7 === 0;
/** Centres of the raster pixels on a grid around pixel (cx, cy), `span` pixels each way, as screen points inside a 640 by 480 map. */
export function centresIn(map, cx, cy, span) {
  const out = [];
  for (let py = cy - span; py < cy + span; py += 3) for (let px = cx - span; px < cx + span; px += 3) {
    const p = map.project(lngLatOfPixel(px, py));
    if (p.x > 4 && p.x < 636 && p.y > 4 && p.y < 476) out.push({ px, py, x: p.x, y: p.y });
  }
  return out;
}
