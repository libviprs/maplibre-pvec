// Passes when the scan is where the first calibration says, then where the second says after layer.update(), at the same screen
// points, and the update asked the server for nothing. Launch through xdg-pw-lock.sh.
import { latticeFailures } from "../lib/checks.mjs";
import { scanFixture } from "../lib/fixtures.mjs";
import { calibration } from "../lib/truth.mjs";
import { runExample } from "../lib/run.mjs";

const before = calibration();
const after = calibration({ dLng: 40 * before.kx, dLat: 25 * before.ky });

await runExample({
  name: "06-georeference-update",
  fixtures: { "/fixtures/scan.pvec": scanFixture() },
  check: (r) => {
    const f = [];
    if (r.errors.length) f.push(`layer errors: ${r.errors}`);
    if (r.rasters !== 1) f.push(`rasters drawn: ${r.rasters}`);
    f.push(...latticeFailures(r.first, before).map((m) => `before: ${m}`));
    f.push(...latticeFailures(r.second, after).map((m) => `after: ${m}`));
    const moved = r.first.filter((s, i) => s.rgba.join() !== r.second[i].rgba.join()).length;
    if (moved < 4) f.push(`only ${moved} lattice points changed after the update`);
    if (r.requestsAfter !== r.requestsBefore) f.push(`update asked the server for the file ${r.requestsAfter - r.requestsBefore} more times`);
    return f;
  },
});
