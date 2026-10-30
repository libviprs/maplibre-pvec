#!/usr/bin/env node
// Hardware GPU run (#82).
//   node bench/hw/run.mjs bundle --out <dir>        build the page bundle (run in a container)
//   node bench/hw/run.mjs run --engine chromium|webkit --bundle <dir> --host <label> [--duration 60000]
//       [--angle metal|gl|gl-egl|vulkan] [--headed (needs xvfb-run)] [--out bench/results/hw] [--playwright-core <dir>] [--device /dev/dri ok]
// `run` refuses a software renderer. On the Mac it is launched through
// /Users/rom/workspace/xdg-pw-lock.sh. In a container it gets the host's /dev/dri passed through.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, platform, arch, release } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const cmd = process.argv[2];

if (cmd === "bundle") {
  const { build } = await import("esbuild");
  const out = resolve(arg("out", ".cache/hw"));
  await mkdir(out, { recursive: true });
  await build({ entryPoints: [join(root, "bench/hw/page.ts")], bundle: true, format: "iife", globalName: "HW", outfile: join(out, "page.js"), logLevel: "error" });
  await writeFile(join(out, "index.html"), '<!doctype html><meta charset="utf-8"><title>hw</title><body style="margin:0"><script src="page.js"></script>');
  // The result validator ships in the bundle so `run` needs no build tooling (it runs on the Mac, outside docker).
  await build({ entryPoints: [join(root, "bench/lib/hardware.ts")], bundle: true, format: "esm", platform: "node", outfile: join(out, "hardware.mjs"), logLevel: "error" });
  console.log(`bundle in ${out}`);
} else if (cmd === "run") {
  const bundleDir = resolve(arg("bundle", ".cache/hw"));
  const { validateHardwareResult, isSoftwareRenderer } = await import(pathToFileURL(join(bundleDir, "hardware.mjs")).href);
  const engine = arg("engine", "chromium");
  const duration = Number(arg("duration", "60000"));
  const angle = arg("angle", "");
  const pwDir = arg("playwright-core", process.env.PW_CORE ?? "");
  const pw = pwDir ? createRequire(join(resolve(pwDir), "x.js"))("playwright-core") : await import("@playwright/test");
  const flags = engine === "chromium" ? ["--use-gl=angle", ...(angle ? [`--use-angle=${angle}`] : []), "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] : [];
  const server = createServer(async (req, res) => {
    const f = req.url === "/" ? "index.html" : req.url.slice(1).split("?")[0];
    try { const b = await readFile(join(bundleDir, f)); res.setHeader("content-type", f.endsWith(".js") ? "text/javascript" : "text/html"); res.end(b); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await pw[engine].launch({ headless: !process.argv.includes("--headed"), args: flags });
  let raw;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: Number(arg("dpr", "2")) });
    const page = await ctx.newPage();
    page.setDefaultTimeout(0);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    raw = await page.evaluate((o) => window.HW.run(o), { durationMs: duration, warmupMs: 3000 });
    var version = browser.version();
  } finally {
    await browser.close();
    server.close();
  }
  const sw = isSoftwareRenderer(`${raw.gpuRenderer} ${raw.gpuVendor}`);
  const { glError, canvasCss, ...rest } = raw;
  const result = {
    schema: 1,
    commit: process.env.BENCH_COMMIT ?? "unknown",
    date: new Date().toISOString(),
    environment: {
      host: arg("host", "unknown"), os: `${platform()} ${release()}`, arch: arch() === "arm64" ? "arm64" : "x64", cpu: cpus()[0]?.model ?? "unknown",
      engine, browserVersion: version, gpuRenderer: raw.gpuRenderer, gpuVendor: raw.gpuVendor, softwareRenderer: sw,
      dpr: raw.dpr, viewport: raw.viewport, timerQuery: raw.timerQuery,
    },
    frames: rest.frames, drawCalls: rest.drawCalls, cpu: rest.cpu, gpu: rest.gpu, draw1e6: rest.draw1e6, upload: rest.upload, snapshot: rest.snapshot,
  };
  const errors = [...validateHardwareResult(result), ...(glError ? [`gl error ${glError}`] : [])];
  const dir = resolve(arg("out", join(root, "bench/results/hw")));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${result.date.slice(0, 10)}-${arg("host", "host")}-${engine}${errors.length ? ".rejected" : ""}.json`);
  await writeFile(file, JSON.stringify(result, null, 2) + "\n");
  console.log(`wrote ${file}`);
  if (errors.length) { for (const e of errors) console.error(`FAIL ${e}`); process.exit(1); }
} else {
  console.error("usage: hw/run.mjs bundle --out dir | run --engine chromium|webkit --bundle dir --host label");
  process.exit(2);
}
