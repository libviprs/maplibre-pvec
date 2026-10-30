// Builds the example containers with the same builder the unit tests use, bundled on the fly.
import { build } from "esbuild";
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
