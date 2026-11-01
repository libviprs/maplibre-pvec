// The shared runner of the map examples: one server on 127.0.0.1, one Chromium context with every other host refused, the page
// loaded, and a verdict written to <out>/<name>.result.json for lib/summary.mjs.
//   node examples/0N-name/run.mjs --pkg <dir of the installed package> --out <dir>
// Launch through /Users/rom/workspace/xdg-pw-lock.sh. The server and the browser are closed on every path.
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { denyExternal } from "./deny.mjs";
import { withServer } from "./serve.mjs";

const examples = join(dirname(fileURLToPath(import.meta.url)), "..");
// Software GL, so a container with no GPU still gets a WebGL2 context.
const GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

/**
 * name: the example directory. fixtures: { "/fixtures/x.pvec": bytes }. check(result, page): returns the list of failures.
 * launchArgs: extra Chromium flags; timeoutMs: how long the page may take to set its result.
 * The page sets window.__result when it is done (or window.__failed with a message).
 */
export async function runExample({ name, fixtures, check, launchArgs = [], timeoutMs = 90_000 }) {
  const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
  const pkgRoot = resolve(arg("--pkg", "."));
  const pkg = join(pkgRoot, "dist");
  const out = resolve(arg("--out", "examples/out"));
  mkdirSync(out, { recursive: true });
  const maplibre = join(pkgRoot, "..", "maplibre-gl", "dist");
  const failures = [];
  const denied = new Set();
  let log = [];
  const browser = await chromium.launch({ args: [...GL, ...launchArgs] });
  try {
    await withServer({ routes: { "/pkg": pkg, "/maplibre": maplibre, "/": examples }, fixtures }, async (s) => {
      const context = await browser.newContext({ viewport: { width: 700, height: 540 } });
      const deny = await denyExternal(context, "127.0.0.1");
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(String(e)));
      const consoleLog = [];
      page.on("console", (m) => consoleLog.push(`${m.type()}: ${m.text()}`));
      try {
        await page.goto(`${s.url}/${name}/index.html`);
        await page.waitForFunction("window.__result !== undefined || window.__failed !== undefined", undefined, { timeout: timeoutMs });
        const failed = await page.evaluate("window.__failed");
        if (failed) failures.push(`page: ${failed}`);
        else failures.push(...(await check(await page.evaluate("window.__result"), { requests: () => s.log })));
        await page.screenshot({ path: join(out, `${name}.png`) });
      } catch (e) {
        failures.push(`run: ${String(e)}`);
        const diag = await page.evaluate("window.__layer ? JSON.stringify({ diag: window.__layer.getDiagnostics(), rasters: window.__layer.rasters() }) : 'no layer'").catch(() => "unreadable");
        failures.push(`layer at timeout: ${diag}`, ...consoleLog.slice(0, 20).map((l) => `console ${l}`));
      }
      failures.push(...pageErrors.map((e) => `pageerror: ${e}`));
      deny.deniedHosts().forEach((h) => denied.add(h));
      log = s.log.map((l) => l.path);
      await context.close();
    });
  } finally {
    await browser.close();
  }
  if (denied.size) failures.push(`outbound hosts refused: ${[...denied].join(", ")}`);
  const ok = failures.length === 0;
  writeFileSync(join(out, `${name}.result.json`), JSON.stringify({ example: name, ok, deniedHosts: [...denied] }) + "\n");
  console.log(JSON.stringify({ example: name, ok, failures, requests: log.length }));
  process.exit(ok ? 0 : 1);
}
