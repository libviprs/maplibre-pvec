// Throwaway spike (M1.6). Runs the same page code in every engine the container offers.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "@playwright/test";
const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, "page.js"), "utf8");
const results = { engines: {} };
for (const [name, type, args] of [["chromium", chromium, ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]], ["firefox", firefox, []], ["webkit", webkit, []]]) {
  let browser;
  try {
    browser = await type.launch({ args }); const page = await browser.newPage(); page.on("pageerror", e => console.log(name, "pageerror", String(e)));
    await page.setContent("<body>"); await page.addScriptTag({ content: code });
    const r = await page.evaluate(() => window.__stroke()); r.version = `${name} ${browser.version()}`; results.engines[name] = r; await browser.close();
    console.log(name, "ok");
  } catch (e) { results.engines[name] = { error: String(e).slice(0, 400) }; console.log(name, "failed", String(e).slice(0, 200)); }
  finally { if (browser) await browser.close().catch(() => {}); }
}
fs.writeFileSync(path.join(here, "results.json"), JSON.stringify(results, null, 2));
