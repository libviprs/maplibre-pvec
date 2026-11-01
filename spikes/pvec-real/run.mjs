// M1.3 / M1.5 on the real pvec evaluator (libviprs/pvec pvec-wasm, wasm/pvec_eval.wasm) and the real
// .pvec bytes (tests/fixtures/pvec, plus the generated benchmark entries in .cache/pvec-large).
// Runs in Chromium inside the Playwright container; tools/spike-real.sh drives it.
//   node spikes/pvec-real/run.mjs           writes spikes/pvec-real/results.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const b64 = (p) => fs.readFileSync(p).toString("base64");
const fixtures = path.join(root, "tests/fixtures/pvec");
const index = JSON.parse(fs.readFileSync(path.join(fixtures, "index.json"), "utf8"));
const largeDir = path.join(root, ".cache/pvec-large");
const large = fs.existsSync(largeDir) ? fs.readdirSync(largeDir).filter((f) => f.endsWith(".pvec")).map((f) => f.replace(/\.pvec$/, "")) : [];

const bundle = await build({
  entryPoints: [path.join(here, "entry.ts")], bundle: true, write: false, format: "iife", globalName: "PvecMlp",
  platform: "browser", target: "es2022", logLevel: "error",
});
const code = bundle.outputFiles[0].text;

// --sections=previews,leak reruns only those parts and merges them into the existing results.json
const sections = process.argv.find((a) => a.startsWith("--sections="))?.slice(11).split(",");
const payload = {
  sections,
  wasm: b64(path.join(root, "wasm/pvec_eval.wasm")),
  small: Object.fromEntries(Object.keys(index.artifacts).map((id) => [id, b64(path.join(fixtures, `${id}.pvec`))])),
  large: Object.fromEntries(large.filter((id) => !id.endsWith("-tier0")).map((id) => [id, b64(path.join(largeDir, `${id}.pvec`))])),
  // The same entries written with a spatial directory and Tier 0 blocks (pvec's indexed layout)
  tier0: Object.fromEntries(large.filter((id) => id.endsWith("-tier0")).map((id) => [id.replace(/-tier0$/, ""), b64(path.join(largeDir, `${id}.pvec`))])),
};

const browser = await chromium.launch({ args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"] });
const page = await browser.newPage();
page.on("console", (m) => console.error("[page]", m.text()));
await page.setContent("<body>");
await page.addScriptTag({ content: code });
const body = fs.readFileSync(path.join(here, "page.js"), "utf8");
const measured = await page.evaluate(`(async (payload) => { ${body}\n return await main(payload); })(${JSON.stringify(payload)})`);
const prior = sections && fs.existsSync(path.join(here, "results.json")) ? JSON.parse(fs.readFileSync(path.join(here, "results.json"), "utf8")) : {};
const kept = Object.fromEntries(Object.entries(measured).filter(([k, v]) => !sections || (Array.isArray(v) ? v.length > 0 : true)));
const results = {
  ...prior,
  browser: `chromium ${browser.version()}`,
  platform: `${process.platform}/${process.arch}`,
  pvecCommit: index.pvecCommit,
  wasmBytes: Buffer.from(payload.wasm, "base64").length,
  ...kept,
};
await browser.close();
fs.writeFileSync(path.join(here, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify({ wrote: "spikes/pvec-real/results.json", fixtures: Object.keys(payload.small).length, large, tier0: Object.keys(payload.tier0) }, null, 1));
