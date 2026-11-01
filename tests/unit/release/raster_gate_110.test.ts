import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RASTER_RENDER_STEADY_P95_MS, rasterBudgetProblems } from "../../../bench/lib/hardware";
import { SUPPORTED_ABI_VERSIONS, loadEvaluator } from "../../../src/wasm/loader";
import { RASTER_EXPORTS, hasRasterExports, openRasterProvider } from "../../../src/wasm/raster";
import { RasterRefusedError } from "../../../src/render/raster/provider";
import { REQUIRED_CONDITIONS, buildGate, evaluateRelease } from "../../../tools/release-gate.mjs";
import { resolveStagedWasm } from "../../../tools/staged-wasm.mjs";
import { EVALUATOR_WASM_BYTES } from "../helpers/probe";

// Issue 110: the release gate with rasters inside it, the pin move and the freeze. The conditions keep their ids and their list; the
// rows that rasters add are measured keys inside them plus one new row, raster_render_budget.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const json = (p: string) => JSON.parse(readFileSync(path.join(root, p), "utf8"));

describe("#110 the gate counts the raster rows", () => {
  const gate = json("release/v1-gate.json");
  const cond = (id: string) => gate.conditions.find((c: { id: string }) => c.id === id);
  it("is what buildGate computes from the tree (red until `tools/release-gate.mjs --write` is rerun)", () => expect(buildGate(root)).toEqual(gate));
  it("leaves the list of required conditions as it was", () => {
    expect(REQUIRED_CONDITIONS).toEqual([
      "conformance_green_every_browser_row", "gates_green_frozen_corpus", "no_quarantined_in_pass_set", "wasm_blocked_paths_documented",
      "lifecycle_leak_and_context_loss", "examples_pass_network_denied", "api_report_identical_to_baseline",
    ]);
  });
  it("counts the raster grid specs inside the conformance condition, the raster cases inside the corpus one, example 07 inside the examples one and the raster names inside the API one", () => {
    expect(cond("conformance_green_every_browser_row").measured.rasterGridSpecs).toBeGreaterThanOrEqual(1);
    expect(cond("gates_green_frozen_corpus").measured.rasterCases).toBe(2);
    expect(cond("examples_pass_network_denied").measured.rasterExamples).toBe(1);
    expect(cond("api_report_identical_to_baseline").measured.rasterNames).toBeGreaterThanOrEqual(5);
  });
  it("adds the raster_render_budget row, met, with the steady and upload-frame figures per real renderer and the baselines as evidence", () => {
    const c = cond("raster_render_budget");
    expect(c, "the row exists").toBeDefined();
    expect(c.status).toBe("met");
    expect(c.spec).toMatch(/1\.5 ms/);
    expect(c.evidence).toMatch(/renderer-baselines\.json/);
    expect(Object.keys(c.measured.renderers)).toHaveLength(3);
    for (const r of Object.values<{ steady: number; statistic: string; uploadFramesP95Ms: number }>(c.measured.renderers)) {
      expect(r.steady).toBeLessThanOrEqual(RASTER_RENDER_STEADY_P95_MS);
      expect(r.statistic).toMatch(/^(p95|mean)$/);
    }
  });
  it("is met for the raster row exactly when the baselines meet the budget (a worse baseline turns it deferred)", () => {
    const b = json("bench/baselines/renderer-baselines.json");
    for (const e of Object.values<{ raster: Parameters<typeof rasterBudgetProblems>[0]["raster"]; timerResolutionMs: number }>(b.rasterEntries)) {
      expect(rasterBudgetProblems({ raster: e.raster, environment: { timerResolutionMs: e.timerResolutionMs } })).toEqual([]);
    }
  });
  it("--tag-check refuses when a raster row is removed, and the tag stays refused because the examples and corpus conditions are open", () => {
    const green = {
      conditions: [...REQUIRED_CONDITIONS, "raster_render_budget"].map((id: string) => ({
        id, status: "met", evidence: "synthetic evidence",
        measured: { rasterGridSpecs: 1, rasterCases: 2, rasterExamples: 1, rasterNames: 5, renderers: { a: { steady: 1, statistic: "p95", uploadFramesP95Ms: 2 } } },
      })),
    };
    expect(evaluateRelease(green).ok).toBe(true);
    const noRow = { conditions: green.conditions.filter((c) => c.id !== "raster_render_budget") };
    expect(evaluateRelease(noRow).problems.join(" ")).toContain("raster_render_budget");
    const noKey = { conditions: green.conditions.map((c) => (c.id === "examples_pass_network_denied" ? { ...c, measured: { rasterGridSpecs: 1 } } : c)) };
    expect(evaluateRelease(noKey).problems.join(" ")).toMatch(/examples_pass_network_denied.*rasterExamples/);
    expect(evaluateRelease(gate).ok, "today's tree still has the examples condition open (#84)").toBe(false);
  });
  it("freezes raster as an optional capability, the texture constant and the render budget, and does not tag", () => {
    const f = json("release/v1-freeze.json");
    expect(f.compatibility.pvec.optionalCapabilities).toContain("raster");
    expect(f.budgets.RASTER_DEFAULTS).toBeDefined();
    expect(f.rasterProvenance.renderBudget.steadyP95Ms).toBe(RASTER_RENDER_STEADY_P95_MS);
    expect(f.status).toMatch(/release not cut/);
    const pkg = json("package.json");
    expect(pkg.private).toBe(true);
    expect(pkg.version).toBe("0.0.0");
  });
});

describe("#110 the pin move and the loader", () => {
  const pin = json("wasm/pvec.pin.json");
  it("pins a pvec commit that has the LIMIT-15 and refused-stream names (7e99ca0 or later), with the digest of the module on disk", () => {
    expect(pin.pvecCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.pvecCommit).not.toBe("e1b8124f00f5b3302d421062f3980e207f3b578b");
    expect(pin.abiVersion).toBe(2);
    const bytes = readFileSync(path.join(root, pin.wasm.file));
    expect(bytes.length).toBe(pin.wasm.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(pin.wasm.sha256);
  });
  it("still supports ABI versions 1 and 2, and no other", () => expect([...SUPPORTED_ABI_VERSIONS]).toEqual([1, 2]));
  it("loadEvaluator probes the raster exports on the pinned module and records hasRaster", async () => {
    const ev = await loadEvaluator({ wasmModule: await WebAssembly.compile(EVALUATOR_WASM_BYTES) });
    expect(ev.hasRaster).toBe(true);
    expect(hasRasterExports(ev)).toBe(true);
    for (const n of RASTER_EXPORTS) expect(typeof (ev.instance.exports as Record<string, unknown>)[n], n).toBe("function");
    expect(RASTER_EXPORTS).toContain("raster_plan");
  });
  it("hasRaster is false for a module that lacks the raster group", async () => {
    const bare = { exports: {} } as unknown as WebAssembly.Instance;
    expect(hasRasterExports({ instance: bare, abiVersion: 2, source: "injected", hasRaster: false })).toBe(false);
  });
  it("the staged-wasm self-test fails a module whose bytes lack the raster exports (the previous pin)", () => {
    expect(() => resolveStagedWasm(path.join(root, "wasm/pvec_eval.wasm"), { abiVersion: 2, rasterExports: [...RASTER_EXPORTS] })).not.toThrow();
    const lacking = new Uint8Array(readFileSync(path.join(root, "wasm/pvec_eval.wasm")).subarray(0, 8));
    expect(() => resolveStagedWasm(lacking as never, { abiVersion: 2, rasterExports: [...RASTER_EXPORTS] })).toThrow();
  });
  it("is the module the build ships: wasm/pvec_eval.wasm is the file the pin names", () => expect(existsSync(path.join(root, "wasm/pvec_eval.wasm"))).toBe(true));
});

describe("#110 the adapter names LIMIT-15 and a refused stream", () => {
  const dir = path.join(root, "tests/fixtures/pvec-raster");
  const file = (rel: string) => new Uint8Array(readFileSync(path.join(dir, rel)));
  const reader = (b: Uint8Array) => ({ artifactLength: b.length as number | undefined, readRange: (o: number, n: number) => Promise.resolve(b.slice(o, o + n)) });
  const evaluator = async () => loadEvaluator({ wasmModule: await WebAssembly.compile(EVALUATOR_WASM_BYTES) });
  it.each(["hostile/oversized-tile.pvec", "hostile/tile-at-limit-15-plus-one.pvec"])("%s: the tile call is refused with LIMIT-15 (-10, rule 15, family 1)", async (rel) => {
    const p = (await openRasterProvider(await evaluator(), reader(file(rel))))!;
    const err = await p.tile(0, 0, 0, 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RasterRefusedError);
    expect((err as RasterRefusedError).rule).toBe("LIMIT-15");
  });
  it("a raster stream the rules refuse as a whole names its rule on the provider", async () => {
    const p = (await openRasterProvider(await evaluator(), reader(file("hostile/jpeg-under-an-rgba-placement.pvec"))))!;
    expect(p, "a provider with no rasters that says why").not.toBeNull();
    expect(p.placements()).toEqual([]);
    expect(p.refusedStream).toEqual({ rule: "RASTER-04", message: expect.stringContaining("RASTER-04") });
  });
});
