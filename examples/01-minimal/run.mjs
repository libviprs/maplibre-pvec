// node examples/01-minimal/run.mjs --pkg <dir of the installed maplibre-pvec> [--out <dir>]
// Runs the page in headless Chromium under three deployments and asserts the documented end state:
//   csp-ok       default-src 'self'; script-src 'self' 'wasm-unsafe-eval'      -> ready
//   csp-strict   same without 'wasm-unsafe-eval' (compile is refused)         -> wasm_unavailable
//   blocked      the .wasm request is aborted                                 -> wasm_unavailable
// Launch through /Users/rom/workspace/xdg-pw-lock.sh. The server is closed on every path.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { smallFixture } from "../lib/fixtures.mjs";
import { withServer } from "../lib/serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
const pkg = join(resolve(arg("--pkg")), "dist");
const out = resolve(arg("--out") ?? join(here, "out"));
mkdirSync(out, { recursive: true });

const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'";
const cases = [
  { name: "csp-ok", csp: CSP, expect: (r) => r.errors.length === 0 && [1, 2].includes(r.wasm.abi) && r.wasm.source === "default" && r.transport === "transfer" && r.crossOriginIsolated === false },
  { name: "csp-strict", csp: "default-src 'self'; script-src 'self'; style-src 'self'", expect: (r) => r.errors.length === 1 && r.errors[0].code === "wasm_unavailable" },
  { name: "blocked", csp: CSP, block: /\.wasm$/, expect: (r) => r.errors.length === 1 && r.errors[0].code === "wasm_unavailable" },
];

let failed = 0;
const browser = await chromium.launch();
try {
  for (const c of cases) {
    await withServer({ routes: { "/pkg": pkg, "/": join(here, "..") }, fixtures: { "/fixtures/small.pvec": smallFixture() }, csp: c.csp }, async (s) => {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(String(e)));
      if (c.block) await page.route(c.block, (r) => r.abort());
      await page.goto(`${s.url}/01-minimal/index.html`);
      // No page.evaluate or waitForFunction: Playwright evals strings, which the page's CSP refuses.
      await page.waitForSelector("#status[data-state]");
      const r = JSON.parse(await page.locator("#out").textContent());
      await page.screenshot({ path: join(out, `01-minimal-${c.name}.png`) });
      await page.close();
      const ok = c.expect(r) && pageErrors.length === 0;
      if (!ok) failed++;
      console.log(JSON.stringify({ case: c.name, ok, result: r, pageErrors }));
    });
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
