// node examples/07-raster-underlay/run.mjs --pkg <dir of the installed maplibre-pvec> [--out <dir>]
// A scan under and over a drawing, in headless Chromium, against the page's own 127.0.0.1 server and with every other origin refused:
//   csp-ok    libviprs's two conversions of a scanned PDF (band 0 and band 1, with the linework as an entity) and pvec's synthetic
//             raster file (the third raster has a codec the reader does not know) -> band 0 puts the linework on top (a red pixel
//             at the stroke), band 1 puts the scan on top (a grey one), the unknown codec is one rasterskipped with RASTER-04, the
//             attribution is in MapLibre's control as text, and the toggle off paints less than half
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
const fixtures = {
  "/fixtures/under.pvec": readFileSync(join(root, "tests/fixtures/pvec-raster/libviprs/scan_under_linework.pvec")),
  "/fixtures/over.pvec": readFileSync(join(root, "tests/fixtures/pvec-raster/libviprs/scan_over_linework.pvec")),
  "/fixtures/synthetic.pvec": readFileSync(join(root, "tests/fixtures/pvec-raster/synthetic.pvec")),
};

// Decode runs in a blob worker, so the page needs worker-src blob:. Nothing else leaves 'self'.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'";

let failed = 0;
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  await withServer({ routes: { "/pkg": pkg, "/maplibre": maplibre, "/": join(here, "..") }, fixtures, csp: CSP }, async (s) => {
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
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[page ${m.type()}] ${m.text().slice(0, 300)}`); });
    page.on("requestfailed", (r) => console.log(`[request failed] ${r.url()} ${r.failure()?.errorText}`));
    await page.goto(`${s.url}/07-raster-underlay/index.html`);
    await page.waitForSelector("#status[data-state]", { timeout: 240_000 }).catch(async (e) => { console.log(`[timeout] status text: ${await page.locator("#status").textContent()}; pageErrors ${JSON.stringify(pageErrors)}`); throw e; });
    const r = JSON.parse(await page.locator("#out").textContent());
    const attributionText = await page.locator(".maplibregl-ctrl-attrib").first().textContent().catch(() => "");
    await page.screenshot({ path: join(out, "07-raster-underlay.png") });
    await page.close();
    const u = r.cases.under, o = r.cases.over, m = r.cases.mixed;
    const reddish = (p) => p[0] > 150 && p[1] < 80 && p[2] < 80;
    const grey = (p) => Math.abs(p[0] - p[1]) < 12 && Math.abs(p[1] - p[2]) < 12 && p[0] > 30 && p[0] < 230;
    const checks = {
      noErrors: r.errors.length === 0,
      underIsBand0: u.rasters.length === 1 && u.rasters[0].band === 0 && u.skipped.length === 0,
      underLineworkOnTop: u.painted > 1000 && reddish(u.centrePixel),
      overIsBand1: o.rasters.length === 1 && o.rasters[0].band === 1 && o.skipped.length === 0,
      overScanOnTop: o.painted > 1000 && grey(o.centrePixel),
      mixedOneSkippedWithRule: m.rasters.length === 2 && m.skipped.length === 1 && m.skipped[0].rasterId === 2 && m.skipped[0].rule === "RASTER-04",
      attributionAsText: m.attribution.length > 0 && attributionText.includes("<1998>"),
      toggleOffDrawsLess: r.offPixels < m.painted / 2,
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
