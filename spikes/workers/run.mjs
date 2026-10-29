// Throwaway spike (M1.7). Two runs: without COOP/COEP (crossOriginIsolated false) and with them.
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
const here = path.dirname(fileURLToPath(import.meta.url));
let isolated = false;
const server = http.createServer((req, res) => {
  const f = path.join(here, req.url.split("?")[0] === "/" ? "harness.html" : req.url.split("?")[0].slice(1));
  if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
  const h = { "content-type": f.endsWith(".js") ? "text/javascript" : "text/html" };
  if (isolated) { h["Cross-Origin-Opener-Policy"] = "same-origin"; h["Cross-Origin-Embedder-Policy"] = "require-corp"; }
  res.writeHead(200, h).end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const results = { browser: `chromium ${browser.version()}`, runs: {} };
for (const iso of [false, true]) {
  isolated = iso;
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  page.on("console", m => console.log("page:", m.text()));
  page.on("pageerror", e => console.log("pageerror", String(e)));
  page.on("close", () => console.log("page closed"));
  page.on("crash", () => console.log("page crashed"));
  page.on("framenavigated", f => console.log("navigated", f.url()));
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.__run === "function");
  console.log("isolated flag", iso, await page.evaluate(() => crossOriginIsolated));
  results.runs[iso ? "coop_coep_present" : "coop_coep_absent"] = await page.evaluate(() => window.__run());
  await ctx.close();
}
await browser.close(); server.close();
fs.writeFileSync(path.join(here, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 1));
