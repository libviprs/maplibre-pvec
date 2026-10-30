// Release gate for the v1 freeze.
//   node tools/release-gate.mjs --write        rewrite release/v1-gate.json from the tree
//   node tools/release-gate.mjs --check        fail when the committed gate differs from the tree
//   node tools/release-gate.mjs --freeze-api   record the current API report in release/v1-freeze.json
//   node tools/release-gate.mjs --tag-check    exit 1 unless every freeze condition is present and met
// Nothing here tags or publishes. The tag step runs --tag-check first and stops when it fails.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApiReport } from "./api-report.mjs";

export const REQUIRED_CONDITIONS = [
  "conformance_green_every_browser_row",
  "gates_green_frozen_corpus",
  "no_quarantined_in_pass_set",
  "wasm_blocked_paths_documented",
  "lifecycle_leak_and_context_loss",
  "examples_pass_network_denied",
  "api_report_identical_to_baseline",
];

const DEFERRED = "docs/deferred.md#issue-40-v1-freeze-and-documentation";
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const root0 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (root, p) => JSON.parse(readFileSync(path.join(root, p), "utf8"));

/** Per entry, per symbol, a hash of the declaration text in the API report. */
export function apiSymbols(report) {
  const out = {};
  for (const entry of report.split(/^## Entry /m).slice(1)) {
    const name = entry.match(/^`([^`]+)`/)[1];
    out[name] = {};
    for (const sym of entry.split(/^### /m).slice(1)) {
      const id = sym.split("\n", 1)[0].trim();
      out[name][id] = sha256(sym.slice(sym.indexOf("\n")).trim());
    }
  }
  return out;
}

/** Semver rule: additions are minor, removals or signature changes are major. */
export function classifyApiChange(frozen, current) {
  let level = "none";
  for (const entry of new Set([...Object.keys(frozen), ...Object.keys(current)])) {
    const a = frozen[entry] ?? {};
    const b = current[entry] ?? {};
    for (const id of Object.keys(a)) if (b[id] !== a[id]) return "major";
    if (Object.keys(b).some((id) => !(id in a))) level = "minor";
  }
  return level;
}

const SNAPSHOT_LIMIT = 0.001;
/** Reads the measured run of the wired layer (tests/e2e/83-*.spec.ts) and says which conditions it supports. */
export function wiredLayerEvidence(root) {
  const file = path.join(root, "release/evidence/83-wired-layer.json");
  const none = { wasmOk: false, lossOk: false, wasmMeasured: {}, lossMeasured: {} };
  if (!existsSync(file)) return none;
  const e = JSON.parse(readFileSync(file, "utf8"));
  const w = e.wasmBlocked, c = e.contextLoss, k = e.coexistence, t = e.tarball;
  const wasmOk = w?.errorEvents === 1 && w.code === "wasm_unavailable" && w.rangeRequests === 0 && w.mapLibrePixelDiff <= SNAPSHOT_LIMIT
    && t?.blockedErrorEvents === 1 && t.blockedRangeRequests === 0 && t.installed === true;
  const lossOk = c?.forced === true && c.contextLosses === 1 && c.newRangeRequests === 0 && c.snapshotDiff <= SNAPSHOT_LIMIT
    && k?.stateDiffs === 0 && k.outsideStrokeDiff <= SNAPSHOT_LIMIT && k.symbolLayerDiff <= SNAPSHOT_LIMIT;
  return {
    wasmOk, lossOk,
    wasmMeasured: { errorEvents: w?.errorEvents, rangeRequests: w?.rangeRequests, mapLibrePixelDiff: w?.mapLibrePixelDiff, tarballBlockedErrorEvents: t?.blockedErrorEvents },
    lossMeasured: { newRangeRequests: c?.newRangeRequests, snapshotDiff: c?.snapshotDiff, outsideStrokeDiff: k?.outsideStrokeDiff, symbolLayerDiff: k?.symbolLayerDiff, stateDiffs: k?.stateDiffs },
  };
}

export function buildGate(root = root0) {
  const compat = readJson(root, "compatibility.json");
  const corpus = readJson(root, "bench/corpus/corpus.json");
  const freeze = readJson(root, "release/v1-freeze.json");
  const report = readFileSync(path.join(root, "etc/maplibre-pvec.api.md"), "utf8");
  const results = readdirSync(path.join(root, "bench/results")).filter((f) => f.endsWith(".json")).sort();
  const latest = readJson(root, `bench/results/${results.at(-1)}`);

  const rows = compat.browsers;
  const supported = rows.filter((b) => b.status === "supported").length;
  const pending = corpus.cases.filter((c) => c.pvec.status === "PENDING").length;
  const quarantined = corpus.cases.filter((c) => /QUARANTINED/.test(c.evidenceClass)).length;
  const exampleDirs = readdirSync(path.join(root, "examples")).filter((d) => /^\d\d-/.test(d)).length;
  const live = buildApiReport(root).text;
  const change = classifyApiChange(freeze.api.symbols, apiSymbols(live));
  const apiSame = live === report && sha256(live) === freeze.api.reportSha256;

  const layer = wiredLayerEvidence(root);
  const cond = (id, spec, met, measured, evidence) => ({
    id, spec, status: met ? "met" : "deferred", measured, evidence, ...(met ? {} : { deferredIn: DEFERRED }),
  });
  return {
    schema: 1,
    note: "Produced by tools/release-gate.mjs. The release step refuses to tag unless every condition is present and met.",
    conditions: [
      cond(REQUIRED_CONDITIONS[0], "conformance suite green on every supported browser row (M2.8 / M7.7)", supported === rows.length,
        { supportedRows: supported, rows: rows.length }, "compatibility.json browsers: chromium supported, firefox and webkit pending"),
      cond(REQUIRED_CONDITIONS[1], "all gates green on the frozen corpus after tuning (M8.2 - M8.5, M8.6)", pending === 0 && latest.variance.ok,
        { casesWithPvecBytes: corpus.cases.length - pending, cases: corpus.cases.length, varianceOk: latest.variance.ok }, "bench/corpus/corpus.json pvec.status, latest bench/results file"),
      cond(REQUIRED_CONDITIONS[2], "no QUARANTINED fixture in the pass set (EPIC O classes)", quarantined === 0 && pending === 0,
        { quarantined, passSetCases: corpus.cases.length - pending }, "the pass set is empty until the corpus has real .pvec bytes, so the absence is not yet evidence"),
      cond(REQUIRED_CONDITIONS[3], "WASM-blocked and non-isolated paths behave as documented (M7.6)", layer.wasmOk,
        { documented: existsSync(path.join(root, "docs/wasm-worker-deployment.md")), verifiedThroughLayer: layer.wasmOk, ...layer.wasmMeasured },
        layer.wasmOk ? "release/evidence/83-wired-layer.json, measured in Chromium through the wired layer and through the installed tarball" : "no evidence from the wired layer: release/evidence/83-wired-layer.json is missing or outside its limits"),
      cond(REQUIRED_CONDITIONS[4], "lifecycle leak and context-loss tests green (M7.2)", layer.lossOk,
        { leakTests: "lifecycle.test.ts (structural)", contextLossSnapshot: layer.lossOk, ...layer.lossMeasured },
        layer.lossOk ? "release/evidence/83-wired-layer.json: forced WEBGL_lose_context on a WebGL2 canvas through the layer, zero new range requests, snapshot within 0.1 percent; coexistence with MapLibre's own layers on a real map" : "no evidence from the wired layer: release/evidence/83-wired-layer.json is missing or outside its limits"),
      cond(REQUIRED_CONDITIONS[5], "examples pass with outbound network denied (M7.8)", exampleDirs >= 6 && latest.deniedHosts.length === 0,
        { examplesWritten: exampleDirs, examplesPlanned: 6, deniedHosts: latest.deniedHosts.length }, "examples/README.md: 01-minimal runs against its own 127.0.0.1 server, 02 to 06 are not written"),
      cond(REQUIRED_CONDITIONS[6], "API report identical to the committed baseline (M7.1)", apiSame && change === "none",
        { reportSha256: sha256(live), change }, "etc/maplibre-pvec.api.md regenerated from the sources and compared with release/v1-freeze.json"),
    ],
  };
}

export function evaluateRelease(gate) {
  const problems = [];
  for (const id of REQUIRED_CONDITIONS) {
    const c = gate.conditions.find((x) => x.id === id);
    if (!c) problems.push(`missing condition ${id}`);
    else if (c.status !== "met") problems.push(`${id} is ${c.status}`);
  }
  return { ok: problems.length === 0, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  const gateFile = path.join(root0, "release/v1-gate.json");
  if (arg === "--write") writeFileSync(gateFile, JSON.stringify(buildGate(), null, 2) + "\n");
  else if (arg === "--freeze-api") {
    const f = path.join(root0, "release/v1-freeze.json");
    const freeze = JSON.parse(readFileSync(f, "utf8"));
    const report = buildApiReport(root0).text;
    freeze.api = { ...freeze.api, reportSha256: sha256(report), symbols: apiSymbols(report) };
    writeFileSync(f, JSON.stringify(freeze, null, 2) + "\n");
  } else if (arg === "--check") {
    const same = JSON.stringify(buildGate()) === JSON.stringify(JSON.parse(readFileSync(gateFile, "utf8")));
    if (!same) { console.error("release/v1-gate.json is stale: run node tools/release-gate.mjs --write"); process.exit(1); }
  } else if (arg === "--tag-check") {
    const r = evaluateRelease(JSON.parse(readFileSync(gateFile, "utf8")));
    if (!r.ok) { console.error("refusing to tag 1.0.0:\n  " + r.problems.join("\n  ")); process.exit(1); }
    console.log("every freeze condition is met");
  } else { console.error("usage: --write | --check | --freeze-api | --tag-check"); process.exit(2); }
}
