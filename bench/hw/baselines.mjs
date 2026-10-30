#!/usr/bin/env node
// Merge hardware result files into the renderer-keyed baselines (#82).
//   node bench/hw/baselines.mjs --bundle <dir> --tuned "<renderer> | <engine>,..." bench/results/hw/a.json ...
// Existing entries for other renderers are kept; software results are refused.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const { baselineKey, validateHardwareResult, validateBaselines } = await import(pathToFileURL(join(resolve(arg("bundle", ".cache/hw")), "hardware.mjs")).href);
const file = join(root, "bench/baselines/renderer-baselines.json");
let base = { schema: 1, tunedFrom: [], entries: {} };
try { base = JSON.parse(await readFile(file, "utf8")); } catch {}
const flags = new Set(["--bundle", "--tuned"]);
const inputs = process.argv.slice(2).filter((a, i, all) => !flags.has(a) && !flags.has(all[i - 1]));
for (const f of inputs) {
  const r = JSON.parse(await readFile(f, "utf8"));
  const errors = validateHardwareResult(r);
  if (errors.length) throw new Error(`${f}: ${errors.join("; ")}`);
  const e = r.environment;
  base.entries[baselineKey(e.gpuRenderer, e.engine)] = {
    engine: e.engine, arch: e.arch, os: e.os, softwareRenderer: false, browserVersion: e.browserVersion,
    source: relative(root, resolve(f)), frames: r.frames, drawCalls: r.drawCalls, cpu: r.cpu, gpu: r.gpu, draw1e6: r.draw1e6, upload: r.upload, snapshot: r.snapshot,
  };
}
if (arg("tuned")) base.tunedFrom = arg("tuned").split(",");
const errors = validateBaselines(base);
if (errors.length) throw new Error(errors.join("\n"));
await writeFile(file, JSON.stringify(base, null, 2) + "\n");
console.log(`wrote ${file} with ${Object.keys(base.entries).length} entries`);
