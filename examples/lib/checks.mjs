import { calibration, expectedAt, near, sourceOf } from "./truth.mjs";

/** Compares a lattice of screen samples with the known truth under a calibration. Returns the failures. */
export function latticeFailures(samples, cal) {
  const failures = [];
  let inside = 0, outside = 0;
  for (const s of samples) {
    const [x, y] = sourceOf(s.lng, s.lat, cal);
    const want = expectedAt(x, y);
    if (!want) continue;
    want[0] === 223 ? outside++ : inside++;
    if (!near(s.rgba, want)) failures.push(`at (${s.cssX}, ${s.cssY}) source (${x.toFixed(1)}, ${y.toFixed(1)}) got ${s.rgba.slice(0, 3)} want ${want}`);
  }
  if (inside < 4) failures.push(`only ${inside} lattice points fell on the scan`);
  if (outside < 4) failures.push(`only ${outside} lattice points fell outside the scan: ${samples.map((s) => sourceOf(s.lng, s.lat, cal).map((v) => v.toFixed(0)).join(",")).join(" ")}`);
  return failures;
}

export function smallScanChecks(r, offset) {
  const f = [];
  if (r.errors.length) f.push(`layer errors: ${r.errors}`);
  if (r.rasters !== 1) f.push(`rasters drawn: ${r.rasters}`);
  return f.concat(latticeFailures(r.samples, calibration(offset)));
}
