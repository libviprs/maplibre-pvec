#!/usr/bin/env node
// Benchmark harness entry point.
//   node bench/run.mjs build-corpus      derive bench/corpus/corpus.json from the pinned manifest
//   node bench/run.mjs check             validate corpus.json (schema, upstream manifest, evidence class)
//   node bench/run.mjs run [--repeat 5] [--cases id,id] [--out bench/results]
// Runs only inside a throw-away container (tools/bench.sh). Outbound network is denied except the
// local fixture origin. Cases are consumed as prebuilt .pvec; none exist yet, so this run replays
// each case's viewport script on the MapLibre map WITHOUT the add-on, which is the baseline every
// later benchmark is measured against.
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(root, ".cache", "bench");
const VARIANCE_LIMIT = 0.15;

async function lib() {
  await mkdir(cache, { recursive: true });
  const outfile = join(cache, "lib.mjs");
  await build({
    entryPoints: [join(root, "bench", "lib", "index.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    external: ["@playwright/test"],
    logLevel: "error",
  });
  return import(pathToFileURL(outfile).href);
}

async function registry(l) {
  const pin = JSON.parse(await readFile(join(root, "tests/fixtures/pin.json"), "utf8"));
  return l.loadRegistry(l.fsSource(join(root, "tests/fixtures/corpus")), pin, await l.loadPvecIndex(join(root, "tests/fixtures/pvec")));
}

function platform() {
  if (process.platform !== "linux") throw new Error(`refusing to run on ${process.platform}: benchmarks run in a Linux container, never under Rosetta`);
  if (process.arch === "arm64") return "linux/arm64";
  if (process.arch === "x64" && process.env.BENCH_NATIVE_X86_64 === "1") return "linux/x86_64 native";
  throw new Error("x86_64 is only accepted on the native docker host (BENCH_NATIVE_X86_64=1 from tools/bench.sh), never emulated");
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

async function checkCorpus(l) {
  const reg = await registry(l);
  const corpus = JSON.parse(await readFile(join(root, "bench/corpus/corpus.json"), "utf8"));
  const { errors, missingClasses } = l.validateCorpus(corpus, reg);
  if (errors.length) throw new Error(`corpus.json is invalid:\n${errors.join("\n")}`);
  console.log(`corpus ok: ${corpus.cases.length} cases, classes without a case yet: ${missingClasses.join(", ")}`);
  return corpus;
}

async function run(l) {
  const corpus = await checkCorpus(l);
  const ids = arg("cases", "").split(",").filter(Boolean);
  const cases = ids.length ? corpus.cases.filter((c) => ids.includes(c.fixtureId)) : corpus.cases;
  if (!cases.length) throw new Error("no cases selected");
  const repeat = Number(arg("repeat", "5"));
  const plat = platform();

  const appDir = join(cache, "app");
  await mkdir(appDir, { recursive: true });
  await build({ entryPoints: [join(root, "bench/page/entry.ts")], bundle: true, format: "esm", outfile: join(appDir, "entry.js"), logLevel: "error", loader: { ".css": "empty" } });
  await writeFile(join(appDir, "index.html"), '<!doctype html><meta charset="utf-8"><title>bench</title><div id="map" style="width:1600px;height:1000px"></div><script type="module" src="entry.js"></script>');
  const { createOrigin } = await import(pathToFileURL(join(root, "tools/fixture-origin.mjs")).href);
  const server = createOrigin({ corpusDir: join(root, "tests/fixtures/corpus"), appDir });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const runs = {};
  let env;
  let blocked = [];
  try {
    for (const c of cases) {
      const rec = (runs[c.fixtureId] = { first_useful_drawing_ms: [], p95_frame_ms: [], max_frame_ms: [] });
      // Two unrecorded warm-ups per case (shader compile, page cache), then the recorded repeats.
      for (let i = -2; i < repeat; i++) {
        const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
        const denied = await l.denyExternal(ctx, "127.0.0.1");
        const page = await ctx.newPage();
        await page.goto(`http://127.0.0.1:${port}/app/index.html`);
        await page.waitForFunction(() => typeof window.benchRun === "function");
        const r = await page.evaluate((s) => window.benchRun(s), c.viewport);
        if (i < 0) {
          await ctx.close();
          continue;
        }
        rec.first_useful_drawing_ms.push(r.firstUsefulDrawingMs);
        rec.p95_frame_ms.push(r.p95FrameMs);
        rec.max_frame_ms.push(r.maxFrameMs);
        blocked = [...new Set([...blocked, ...denied.hosts()])];
        env ??= { gpuRenderer: r.gpuRenderer, crossOriginIsolated: r.crossOriginIsolated };
        await ctx.close();
      }
    }
    env = {
      browser: "chromium",
      browserVersion: browser.version(),
      cpu: cpus()[0]?.model ?? "unknown",
      gpuRenderer: env.gpuRenderer,
      softwareRenderer: /swiftshader|llvmpipe|software/i.test(env.gpuRenderer),
      crossOriginIsolated: env.crossOriginIsolated,
      platform: plat,
    };
  } finally {
    await browser.close();
    server.close();
  }

  const flat = {};
  for (const [id, m] of Object.entries(runs)) {
    flat[`${id}/first_useful_drawing_ms`] = m.first_useful_drawing_ms;
    flat[`${id}/p95_frame_ms`] = m.p95_frame_ms;
  }
  const variance = l.checkVariance(flat, VARIANCE_LIMIT);
  const metrics = [];
  for (const [id, m] of Object.entries(runs)) {
    for (const [name, vals] of Object.entries(m)) {
      const value = median(vals);
      // The subject is the baseline (map without the add-on), so baseline equals the measured median
      // and every threshold is informational until M8.2-M8.5 own theirs.
      metrics.push({ case: id, name: `${name}.median`, value, baseline: value, threshold: { op: "info" } });
    }
  }
  const commit = process.env.BENCH_COMMIT ?? "unknown";
  const result = {
    schema: 1,
    commit,
    date: new Date().toISOString(),
    environment: env,
    corpus: { file: "bench/corpus/corpus.json", cases: cases.length },
    subject: "MapLibre map without the add-on, software GL (SwiftShader): relative numbers only, not hardware numbers",
    runs,
    variance,
    metrics,
    deniedHosts: blocked,
  };
  const errors = [...l.validateResult(result), ...l.evaluateMetrics(metrics)];
  const dir = join(root, arg("out", "bench/results"));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${result.date.slice(0, 10)}-${commit}${errors.length ? ".rejected" : ""}.json`);
  await writeFile(file, JSON.stringify(result, null, 2) + "\n");
  console.log(`wrote ${file}`);
  for (const f of variance.failures) console.error(`VARIANCE ${f}`);
  if (errors.length) {
    for (const e of errors) console.error(`FAIL ${e}`);
    process.exit(1);
  }
}

const cmd = process.argv[2];
const l = await lib();
if (cmd === "build-corpus") {
  const corpus = l.buildCorpus(await registry(l));
  await writeFile(join(root, "bench/corpus/corpus.json"), JSON.stringify(corpus, null, 2) + "\n");
  console.log(`wrote ${corpus.cases.length} cases`);
} else if (cmd === "check") await checkCorpus(l);
else if (cmd === "run") await run(l);
else {
  console.error("usage: run.mjs build-corpus | check | run [--repeat N] [--cases a,b] [--out dir]");
  process.exit(2);
}
