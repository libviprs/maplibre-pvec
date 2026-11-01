#!/usr/bin/env node
// Merge hardware result files into the renderer-keyed baselines (#82).
//   node bench/hw/baselines.mjs --bundle <dir> --tuned all bench/results/hw/a.json ...
// Existing entries for other renderers are kept. A result that says softwareRenderer true (an arm64 Linux container,
// no GPU) goes to softwareEntries and is never tuning input; hardware entries stay hardware only.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const { baselineKey, validateHardwareResult, validateSoftwareResult, validateRasterResult, validateBaselines } = await import(pathToFileURL(join(resolve(arg("bundle", ".cache/hw")), "hardware.mjs")).href);
const file = join(root, "bench/baselines/renderer-baselines.json");
let base = { schema: 1, tunedFrom: [], entries: {} };
try { base = JSON.parse(await readFile(file, "utf8")); } catch {}
const flags = new Set(["--bundle", "--tuned"]);
const inputs = process.argv.slice(2).filter((a, i, all) => !flags.has(a) && !flags.has(all[i - 1]));
for (const f of inputs) {
  const r = JSON.parse(await readFile(f, "utf8"));
  const software = r.environment?.softwareRenderer === true;
  const rasterOnly = r.raster && !r.frames;
  const errors = rasterOnly ? validateRasterResult(r, software) : software ? validateSoftwareResult(r) : validateHardwareResult(r);
  if (errors.length) throw new Error(`${f}: ${errors.join("; ")}`);
  const e = r.environment;
  if (rasterOnly) {
    // Rasters through the wired layer (#108): apart from the stroke entries, hardware and software kept separate.
    const t = software ? (base.softwareRasterEntries ??= {}) : (base.rasterEntries ??= {});
    t[software ? `${baselineKey(e.gpuRenderer, e.engine)} | ${e.arch}` : baselineKey(e.gpuRenderer, e.engine)] = {
      engine: e.engine, arch: e.arch, os: e.os, softwareRenderer: software, ...(software ? { container: e.container } : {}), browserVersion: e.browserVersion, timerResolutionMs: e.timerResolutionMs,
      source: relative(root, resolve(f)), raster: r.raster,
    };
    continue;
  }
  const table = software ? (base.softwareEntries ??= {}) : base.entries;
  table[baselineKey(e.gpuRenderer, e.engine)] = {
    engine: e.engine, arch: e.arch, os: e.os, softwareRenderer: software, ...(software ? { container: e.container } : {}), browserVersion: e.browserVersion,
    source: relative(root, resolve(f)), frames: r.frames, drawCalls: r.drawCalls, cpu: r.cpu, gpu: r.gpu, draw1e6: r.draw1e6, upload: r.upload, snapshot: r.snapshot,
    ...(r.layer ? { layer: r.layer } : {}),
  };
}
if (arg("tuned") === "all") base.tunedFrom = Object.keys(base.entries);
const errors = validateBaselines(base);
if (errors.length) throw new Error(errors.join("\n"));
await writeFile(file, JSON.stringify(base, null, 2) + "\n");
console.log(`wrote ${file} with ${Object.keys(base.entries).length} entries`);
