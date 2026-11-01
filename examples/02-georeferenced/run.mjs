// Passes when the layer draws the scan where the calibration says: at a lattice of screen points, the pixel is the ramp at the
// source point under it (lib/truth.mjs), or the map's own background outside the sheet. Launch through xdg-pw-lock.sh.
import { smallScanChecks } from "../lib/checks.mjs";
import { scanFixture } from "../lib/fixtures.mjs";
import { runExample } from "../lib/run.mjs";

await runExample({
  name: "02-georeferenced",
  fixtures: { "/fixtures/scan.pvec": scanFixture() },
  check: (r) => smallScanChecks(r, {}),
});
