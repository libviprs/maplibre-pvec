#!/usr/bin/env node
// Turns the Playwright JSON reports of the browser grid (tools/run-grid.sh) into release/browser-grid.json.
// Each grid test attaches a `grid` annotation naming engine, version and MapLibre; this only counts them.
//   node tools/browser-grid.mjs [job-reports]      writes release/browser-grid.json
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2] ?? join(root, "job-reports");

function walk(suites, out) {
  for (const s of suites ?? []) {
    for (const spec of s.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.[t.results.length - 1];
        const a = (t.annotations ?? []).find((x) => x.type === "grid");
        out.push({ status: last?.status ?? "failed", note: a ? JSON.parse(a.description) : null, project: t.projectName });
      }
    }
    walk(s.suites, out);
  }
}

export function summarise(reports) {
  const tests = [];
  for (const r of reports) walk(r.suites, tests);
  const runs = new Map();
  let arch = null;
  for (const t of tests) {
    if (!t.note) continue;
    arch = t.note.arch ?? arch;
    const key = [t.note.kind, t.note.engine, t.note.version, t.note.maplibre ?? ""].join("|");
    const run = runs.get(key) ?? { engine: t.note.engine, version: t.note.version, kind: t.note.kind, ...(t.note.maplibre ? { maplibre: t.note.maplibre } : {}), total: 0, passed: 0 };
    run.total++;
    if (t.status === "passed") run.passed++;
    runs.set(key, run);
  }
  // A test that failed never reached its annotation, so count the unannotated ones against the grid too.
  const unannotated = tests.filter((t) => !t.note).length;
  return { schema: 1, arch, unannotated, runs: [...runs.values()].sort((a, b) => (a.kind + a.engine + a.version + (a.maplibre ?? "")).localeCompare(b.kind + b.engine + b.version + (b.maplibre ?? ""), undefined, { numeric: true })) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const reports = ["grid", "isolated"].map((n) => JSON.parse(readFileSync(join(dir, `${n}.json`), "utf8")));
  const out = summarise(reports);
  writeFileSync(join(root, "release", "browser-grid.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote release/browser-grid.json: ${out.runs.length} runs, ${out.unannotated} unannotated tests`);
}
