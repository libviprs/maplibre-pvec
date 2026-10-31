#!/usr/bin/env node
// Hardware GPU run (#82).
//   node bench/hw/run.mjs bundle --out <dir>        build the page bundle (run in a container)
//   node bench/hw/run.mjs run --engine chromium|webkit --bundle <dir> --host <label> [--duration 60000]
//       [--angle metal|gl|gl-egl|vulkan] [--headed (needs xvfb-run)] [--out bench/results/hw] [--playwright-core <dir>] [--device /dev/dri ok]
//       [--software-ok "<container label, must say no GPU>"] (accept SwiftShader, written as a software result)
//       [--diff-frames N] (GL state diff frames in the layer run, default 400; software runs use fewer)
//       [--no-layer] (skip the second 60 s run of the same scene through the wired MapLibre layer)
//       [--raster-only] (#108: only the raster page, written as <date>-<host>-<engine>[-software]-raster.json; the bundle needs --tiles <dir>)
//   node bench/hw/run.mjs bundle --out <dir> --tiles <dir>   also copies the pinned raster tiles (tools/raster-bench-tiles.sh) next to the page
// `run` refuses a software renderer unless --software-ok names the container (then it is a software result). On the Mac it is launched through
// /Users/rom/workspace/xdg-pw-lock.sh. In a container it gets the host's /dev/dri passed through.
import { mkdir, readFile, readdir, copyFile, writeFile } from "node:fs/promises";
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
  // The layer run: the same scene through the wired custom layer on a real map, with a stand-in cursor.
  await build({ entryPoints: [join(root, "bench/hw/layer-page.ts")], bundle: true, format: "iife", globalName: "HWL", outfile: join(out, "layer.js"), define: { "import.meta.url": "location.href" }, logLevel: "error" });
  await writeFile(join(out, "layer.html"), '<!doctype html><meta charset="utf-8"><title>hw layer</title><body style="margin:0"><script src="layer.js"></script>');
  // The layer bootstraps a container before its stand-in cursor takes over, so serve the small test fixture with range support.
  const fx = await build({ stdin: { contents: 'import { buildPvec, gridSpec } from "./tests/unit/helpers/fixture"; export default buildPvec(gridSpec()).bytes;', resolveDir: root, loader: "ts" }, bundle: true, format: "esm", platform: "node", write: false, logLevel: "error" });
  const mod = await import("data:text/javascript;base64," + Buffer.from(fx.outputFiles[0].text).toString("base64"));
  await writeFile(join(out, "p.pvec"), mod.default);
  // The raster page (#108): decode and upload tables, the layer with one and ten scans, the two-scan views, the first drawing over a paced link.
  await build({ entryPoints: [join(root, "bench/hw/raster-page.ts")], bundle: true, format: "iife", globalName: "HWR", outfile: join(out, "raster.js"), define: { "import.meta.url": "location.href" }, logLevel: "error" });
  await writeFile(join(out, "raster.html"), '<!doctype html><meta charset="utf-8"><title>hw raster</title><body style="margin:0"><script src="raster.js"></script>');
  if (arg("tiles", "")) {
    await mkdir(join(out, "tiles"), { recursive: true });
    for (const f of await readdir(resolve(arg("tiles")))) await copyFile(join(resolve(arg("tiles")), f), join(out, "tiles", f));
  }
  // The result validator ships in the bundle so `run` needs no build tooling (it runs on the Mac, outside docker).
  await build({ entryPoints: [join(root, "bench/lib/hardware.ts")], bundle: true, format: "esm", platform: "node", outfile: join(out, "hardware.mjs"), logLevel: "error" });
  console.log(`bundle in ${out}`);
} else if (cmd === "run") {
  const bundleDir = resolve(arg("bundle", ".cache/hw"));
  const { validateHardwareResult, validateSoftwareResult, validateRasterResult, rasterBudgetProblems, isSoftwareRenderer } = await import(pathToFileURL(join(bundleDir, "hardware.mjs")).href);
  const engine = arg("engine", "chromium");
  const duration = Number(arg("duration", "60000"));
  const angle = arg("angle", "");
  const pwDir = arg("playwright-core", process.env.PW_CORE ?? "");
  const pw = pwDir ? createRequire(join(resolve(pwDir), "x.js"))("playwright-core") : await import("@playwright/test");
  const flags = engine === "chromium" ? ["--use-gl=angle", ...(angle ? [`--use-angle=${angle}`] : []), "--ignore-gpu-blocklist", "--enable-gpu-rasterization", ...(arg("software-ok", "") ? ["--enable-unsafe-swiftshader"] : []), "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] : [];
  const server = createServer(async (req, res) => {
    const f = req.url === "/" ? "index.html" : req.url.slice(1).split("?")[0];
    // /net/<mbit>/<tile file>: a tile paced to <mbit> Mbit/s after 20 ms of added latency, in 8 KiB writes (first drawing, #108).
    const net = /^net\/(\d+)\/([\w.-]+)$/.exec(f);
    if (net) {
      try {
        const b = await readFile(join(bundleDir, "tiles", net[2]));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        res.setHeader("content-type", "application/octet-stream");
        res.setHeader("content-length", String(b.length));
        await wait(20);
        for (let at = 0; at < b.length; at += 8192) {
          const chunk = b.subarray(at, at + 8192);
          if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
          await wait((chunk.length * 8) / (Number(net[1]) * 1e6) * 1000);
        }
        res.end();
      } catch { res.statusCode = 404; res.end(); }
      return;
    }
    try {
      const b = await readFile(join(bundleDir, f));
      res.setHeader("content-type", f.endsWith(".js") ? "text/javascript" : f.endsWith(".pvec") ? "application/octet-stream" : "text/html");
      const m = f.endsWith(".pvec") && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      res.setHeader("etag", '"v1"'); res.setHeader("accept-ranges", "bytes");
      if (m) {
        const a = m[1] === "" ? Math.max(0, b.length - Number(m[2])) : Number(m[1]);
        const z = m[1] === "" || m[2] === "" ? b.length - 1 : Math.min(Number(m[2]), b.length - 1);
        res.statusCode = 206; res.setHeader("content-range", `bytes ${a}-${z}/${b.length}`);
        res.end(b.subarray(a, z + 1));
      } else res.end(b);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await pw[engine].launch({ headless: !process.argv.includes("--headed"), args: flags });
  const profile = process.argv.includes("--profile");
  let raw, layerRaw, rasterRaw;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: Number(arg("dpr", "2")) });
    const page = await ctx.newPage();
    page.setDefaultTimeout(0);
    if (process.argv.includes("--raster-only")) {
      page.on("console", (m) => { if (m.text().startsWith("[raster]")) console.log(m.text()); });
      await page.goto(`http://127.0.0.1:${server.address().port}/raster.html`);
      rasterRaw = await page.evaluate((o) => window.HWR.run(o), { durationMs: duration, warmupMs: 3000, diffFrames: Number(arg("diff-frames", "400")), profile });
      var version = browser.version();
      throw Object.assign(new Error("raster done"), { rasterDone: true });
    }
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    raw = await page.evaluate((o) => window.HW.run(o), { durationMs: duration, warmupMs: 3000 });
    if (!process.argv.includes("--no-layer")) {
      await page.close();
      const lp = await ctx.newPage();
      lp.setDefaultTimeout(0);
      await lp.goto(`http://127.0.0.1:${server.address().port}/layer.html`);
      layerRaw = await lp.evaluate((o) => window.HWL.run(o), { durationMs: duration, warmupMs: 3000, profile: profile, diffFrames: Number(arg("diff-frames", "400")) });
    }
    var version = browser.version();
  } catch (e) {
    if (!e?.rasterDone) throw e;
  } finally {
    await browser.close();
    server.close();
  }
  if (rasterRaw) {
    const softwareOk = arg("software-ok", "");
    const { raster, gpuRenderer, gpuVendor, dpr, viewport, timerQuery } = rasterRaw;
    const result = {
      schema: 1,
      commit: process.env.BENCH_COMMIT ?? "unknown",
      date: new Date().toISOString(),
      environment: {
        host: arg("host", "unknown"), os: `${platform()} ${release()}`, arch: arch() === "arm64" ? "arm64" : "x64", cpu: cpus()[0]?.model ?? "unknown",
        ...(softwareOk ? { container: softwareOk } : {}), engine, browserVersion: version, gpuRenderer, gpuVendor, softwareRenderer: isSoftwareRenderer(`${gpuRenderer} ${gpuVendor}`),
        dpr, viewport, timerQuery,
      },
      raster,
    };
    const errors = validateRasterResult(result, !!softwareOk);
    const dir = resolve(arg("out", join(root, "bench/results/hw")));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${result.date.slice(0, 10)}-${arg("host", "host")}-${engine}${softwareOk ? "-software" : ""}-raster${errors.length ? ".rejected" : ""}.json`);
    await writeFile(file, JSON.stringify(result, null, 2) + "\n");
    console.log(`wrote ${file}`);
    for (const p of rasterBudgetProblems(result)) console.log(`NOTE ${p}${softwareOk ? " (software GL, a relative cost)" : ""}`);
    if (errors.length) { for (const e of errors) console.error(`FAIL ${e}`); process.exit(1); }
    process.exit(0);
  }
  if (layerRaw?.glBreakdown) console.log("layer GL breakdown (ms, calls over the run)", JSON.stringify(layerRaw.glBreakdown));
  const softwareOk = arg("software-ok", "");
  const sw = isSoftwareRenderer(`${raw.gpuRenderer} ${raw.gpuVendor}`);
  const { glError, canvasCss, ...rest } = raw;
  const result = {
    schema: 1,
    commit: process.env.BENCH_COMMIT ?? "unknown",
    date: new Date().toISOString(),
    environment: {
      host: arg("host", "unknown"), os: `${platform()} ${release()}`, arch: arch() === "arm64" ? "arm64" : "x64", cpu: cpus()[0]?.model ?? "unknown",
      ...(softwareOk ? { container: softwareOk } : {}), engine, browserVersion: version, gpuRenderer: raw.gpuRenderer, gpuVendor: raw.gpuVendor, softwareRenderer: sw,
      dpr: raw.dpr, viewport: raw.viewport, timerQuery: raw.timerQuery,
    },
    frames: rest.frames, drawCalls: rest.drawCalls, cpu: rest.cpu, gpu: rest.gpu, draw1e6: rest.draw1e6, upload: rest.upload, snapshot: rest.snapshot,
    ...(layerRaw ? { layer: layerRaw.layer } : {}),
  };
  const errors = [...(softwareOk ? validateSoftwareResult(result) : validateHardwareResult(result)), ...(glError ? [`gl error ${glError}`] : []), ...(layerRaw?.glError ? [`layer run gl error ${layerRaw.glError}`] : [])];
  const dir = resolve(arg("out", join(root, "bench/results/hw")));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${result.date.slice(0, 10)}-${arg("host", "host")}-${engine}${softwareOk ? "-software" : ""}${errors.length ? ".rejected" : ""}.json`);
  await writeFile(file, JSON.stringify(result, null, 2) + "\n");
  console.log(`wrote ${file}`);
  if (errors.length) { for (const e of errors) console.error(`FAIL ${e}`); process.exit(1); }
} else {
  console.error("usage: hw/run.mjs bundle --out dir | run --engine chromium|webkit --bundle dir --host label");
  process.exit(2);
}
