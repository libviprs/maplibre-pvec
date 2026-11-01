// node examples/07-raster-underlay/run.mjs --pkg <dir of the installed maplibre-pvec> [--out <dir>]
// A scan under a drawing, in headless Chromium, against the page's own 127.0.0.1 server and with every other origin refused:
//   csp-ok    the package, MapLibre and pvec's synthetic raster file (three rasters, the third with a codec the reader does not know)
//             -> the first two draw (the canvas has painted pixels), the third is one rasterskipped with RASTER-04, no error,
//                the attribution is in MapLibre's control as text, the toggle off paints less than half of what the rasters painted
// Launch through /Users/rom/workspace/xdg-pw-lock.sh. The server is closed on every path.
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withServer } from "../lib/serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
const pkg = join(resolve(arg("--pkg")), "dist");
const out = resolve(arg("--out") ?? join(here, "out"));
mkdirSync(out, { recursive: true });
const maplibre = join(root, "node_modules/maplibre-gl/dist");
const synthetic = readFileSync(join(root, "tests/fixtures/pvec-raster/synthetic.pvec"));

// Decode runs in a blob worker, so the page needs worker-src blob:. Nothing else leaves 'self'.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'";

let failed = 0;
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  await withServer({ routes: { "/pkg": pkg, "/maplibre": maplibre, "/": join(here, "..") }, fixtures: { "/fixtures/synthetic.pvec": synthetic }, csp: CSP }, async (s) => {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    const deniedHosts = [];
    await page.route("**/*", (r) => {
      const u = new URL(r.request().url());
      if (u.hostname === "127.0.0.1") return r.continue();
      deniedHosts.push(u.hostname);
      return r.abort();
    });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(`${s.url}/07-raster-underlay/index.html`);
    await page.waitForSelector("#status[data-state]", { timeout: 120_000 });
    const r = JSON.parse(await page.locator("#out").textContent());
    const attributionText = await page.locator(".maplibregl-ctrl-attrib").first().textContent().catch(() => "");
    await page.screenshot({ path: join(out, "07-raster-underlay.png") });
    await page.close();
    const checks = {
      noErrors: r.errors.length === 0,
      twoRastersDraw: r.rasters.length === 2,
      rasterPixels: r.drawnPixels > 1000,
      toggleOffDrawsLess: r.offPixels < r.drawnPixels / 2,
      oneSkippedWithRule: r.skipped.length === 1 && r.skipped[0].rasterId === 2 && r.skipped[0].rule === "RASTER-04",
      attributionAsText: r.attribution.length > 0 && attributionText.includes("<1998>"),
      noDeniedOrigin: deniedHosts.length === 0,
      noPageError: pageErrors.length === 0,
    };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) failed++;
    console.log(JSON.stringify({ case: "csp-ok", ok, checks, deniedHosts, pageErrors, result: { ...r, rasters: r.rasters } }));
  });
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
