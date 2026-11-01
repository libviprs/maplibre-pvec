// Builds the example containers with the same builder the unit tests use, bundled on the fly.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const out = await build({ entryPoints: [join(root, "tests/unit/helpers/fixture.ts")], bundle: true, format: "esm", write: false, platform: "node" });
const { buildPvec, gridSpec } = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

/** The small structural container: four capabilities, a grid of cells. */
export const smallFixture = () => buildPvec(gridSpec()).bytes;

export { buildPvec, gridSpec };

/** What the documentation samples fetch, by URL path. The same bytes whichever port the samples name. */
export const docsFixtures = () => ({ "/plan.pvec": smallFixture() });

/** The libviprs-converted scan: a 64 by 48 ramp painted 100 by 75 at source (25, 10), with a stroke across it. See lib/truth.mjs. */
export const scanFixture = () => new Uint8Array(readFileSync(join(root, "tests/fixtures/pvec-raster/libviprs/scan_under_linework.pvec")));

/** pvec's known-truth circle (tests/fixtures/pvec/circle-001.pvec): centre (1.5, -2.25), radius 2.75 source units, from pvec-gold-fixtures' expected.math.json. */
export const circleFixture = () => new Uint8Array(readFileSync(join(root, "tests/fixtures/pvec/circle-001.pvec")));
