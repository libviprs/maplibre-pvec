import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as defaults from "../../../src/config/defaults";
import { fitLevels } from "../../../src/render/raster/budget";
import type { RasterPlacement } from "../../../src/render/raster/geometry";
import {
  RASTER_EDGES, RASTER_RENDER_STEADY_P95_MS, RASTER_VARIANTS, isSoftwareRenderer, rasterBudgetProblems, validateBaselines, validateRasterCorpus, validateRasterResult,
  type RasterResult,
} from "../../../bench/lib/hardware";
import { generateDocs } from "../../../tools/docs.mjs";

// Issue 108: rasters through the hardware harness. The validators refuse a raster result without its decode table, without a
// renderer string, or with a software renderer that is not labelled; the corpus validator refuses a raster case whose digest is
// not the pinned one; defaults.ts and release/v1-freeze.json carry the raster constants and move together.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const json = (p: string) => JSON.parse(readFileSync(path.join(root, p), "utf8"));

const frames = { count: 3600, p50Ms: 16.7, p95Ms: 17.2, p99Ms: 18, maxMs: 25, over20Ms: 0 };
const scene = (name: "strokes+1" | "strokes+10", rasters: number): RasterResult["raster"]["scenes"][number] => ({
  name, rasters, durationMs: 60000, segments: 1_000_000, frames,
  render: {
    p50Ms: 0.2, p95Ms: 0.5, maxMs: 1.1,
    steady: { frames: 3300, meanMs: 0.25, p50Ms: 0.2, p95Ms: 0.4, p99Ms: 0.6, maxMs: 1.1, over16_7Ms: [] },
    uploadFrames: { frames: 200, share: 0.057, p50Ms: 0.5, p95Ms: 0.9, maxMs: 1.1, over16_7Ms: [] },
  },
  uploads: { framesWithUploads: 40, maxTilesPerFrame: 4, maxBytesPerFrame: 4 << 20, overBudgetFrames: 0 },
  texture: { peakTextures: 80, peakGpuTierBytes: 80 << 20, gpuBytes: 128 << 20 },
  stateDiffs: 0, errors: 0, mainThreadDecodes: 0,
});
const good = (): RasterResult => ({
  schema: 1,
  commit: "abc1234",
  date: "2026-10-31T10:00:00.000Z",
  environment: {
    host: "test host", os: "macOS", arch: "arm64", cpu: "Apple M5", engine: "chromium", browserVersion: "149.0.0.0",
    gpuRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)", gpuVendor: "Google Inc. (Apple)",
    softwareRenderer: false, dpr: 2, viewport: [1600, 1000], timerQuery: true, timerResolutionMs: 0.1,
  },
  raster: {
    decode: RASTER_VARIANTS.flatMap((variant) => RASTER_EDGES.map((edge) => ({ variant, edge, samples: 30, bytes: 1000, coldMs: 12, p50Ms: 1.2, p95Ms: 2.5 }))),
    upload: RASTER_EDGES.map((edge) => ({ edge, samples: 30, p50Ms: 0.3, p95Ms: 0.6 })),
    scenes: [scene("strokes+1", 1), scene("strokes+10", 10)],
    fit: (["1080p", "4k"] as const).map((view) => ({ view, deviceSize: view === "4k" ? [3840, 2160] as [number, number] : [1920, 1080] as [number, number], rasters: 2, gpuBytes: 128 << 20, peakGpuTierBytes: 100 << 20, textures: 90, levels: [1, 2] })),
    firstDrawing: [{ mbit: 25, ms: 300, bytes: 40000 }, { mbit: 5, ms: 900, bytes: 40000 }],
    replay: ["architectural-1e5+1-scan", "architectural-1e5+10-scans"].flatMap((c) => (["on", "off"] as const).map((rasters) => ({ case: c, rasters, runs: 3, firstDrawingMs: 120, p95FrameMs: 17, maxFrameMs: 30, frames: 500 }))),
  },
});
const soft = (): RasterResult => {
  const r = good();
  r.environment = {
    ...r.environment, host: "mars", os: "linux 6.8", arch: "x64", cpu: "Ryzen", gpuRenderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    gpuVendor: "Google Inc. (Google)", softwareRenderer: true, container: "linux/amd64 container on MARS, software GL (SwiftShader), no GPU",
  };
  return r;
};

describe("#108 raster result files", () => {
  it("accept a complete hardware result", () => expect(validateRasterResult(good(), false)).toEqual([]));
  it("accept a complete software result from a labelled container", () => expect(validateRasterResult(soft(), true)).toEqual([]));
  it("refuse a result without the decode table, or with a variant or a tile size missing from it", () => {
    const r = good();
    r.raster.decode = [];
    expect(validateRasterResult(r, false).join()).toMatch(/decode/);
    const s = good();
    s.raster.decode = s.raster.decode.filter((d) => !(d.variant === "webp-vp8l" && d.edge === 1024));
    expect(validateRasterResult(s, false).join()).toMatch(/decode.*webp-vp8l.*1024/);
  });
  it("refuse a result without a renderer string", () => {
    const r = good();
    r.environment.gpuRenderer = "";
    expect(validateRasterResult(r, false).join()).toMatch(/gpuRenderer/);
  });
  it("refuse a software renderer on the hardware path, and an unlabelled one on the software path", () => {
    expect(validateRasterResult({ ...good(), environment: soft().environment }, false).join()).toMatch(/software/);
    const r = soft();
    delete (r.environment as { container?: string }).container;
    expect(validateRasterResult(r, true).join()).toMatch(/no GPU/);
    expect(validateRasterResult(good(), true).join()).toMatch(/software/);
  });
  it("refuse a software result that is not linux", () => {
    const r = soft();
    r.environment.os = "darwin 27";
    expect(validateRasterResult(r, true).join()).toMatch(/linux/);
  });
  it("refuse a scene run shorter than 60 s, a missing scene, left-over GL state, errors and a main-thread decode", () => {
    const r = good();
    r.raster.scenes[1]!.durationMs = 20000;
    expect(validateRasterResult(r, false).join()).toMatch(/strokes\+10.*60/);
    const m = good();
    m.raster.scenes = m.raster.scenes.slice(0, 1);
    expect(validateRasterResult(m, false).join()).toMatch(/strokes\+10/);
    const d = good();
    d.raster.scenes[0]!.stateDiffs = 3;
    d.raster.scenes[0]!.errors = 1;
    d.raster.scenes[0]!.mainThreadDecodes = 2;
    expect(validateRasterResult(d, false).join()).toMatch(/state.*error|error.*state/s);
    expect(validateRasterResult(d, false).join()).toMatch(/main thread/);
  });
  it("refuse a two-scan view that went over the gpu ceiling, or a missing 1080p or 4K view", () => {
    const r = good();
    r.raster.fit[1]!.peakGpuTierBytes = (128 << 20) + 1;
    expect(validateRasterResult(r, false).join()).toMatch(/4k.*ceiling/);
    const m = good();
    m.raster.fit = m.raster.fit.slice(0, 1);
    expect(validateRasterResult(m, false).join()).toMatch(/4k/);
  });
  it("refuse a result that did not replay a raster case with rasters on and off", () => {
    const r = good();
    r.raster.replay = r.raster.replay.filter((x) => !(x.case === "architectural-1e5+10-scans" && x.rasters === "off"));
    expect(validateRasterResult(r, false).join()).toMatch(/replay.*10-scans.*off/);
  });
  it("asserts the steady p95 against 1.5 ms, upload frames against the upload budget's own rule, and the byte budget", () => {
    expect(RASTER_RENDER_STEADY_P95_MS).toBe(1.5);
    expect(rasterBudgetProblems(good())).toEqual([]);
    const steady = good();
    steady.raster.scenes[1]!.render.steady.p95Ms = 1.6;
    expect(rasterBudgetProblems(steady).join()).toMatch(/strokes\+10.*steady render p95 1\.6 ms is over 1\.5/);
    // all-frames p95 above 1.5 ms alone is not a miss: the upload frames carry their own bound
    const allFrames = good();
    allFrames.raster.scenes[1]!.render.p95Ms = 4;
    expect(rasterBudgetProblems(allFrames)).toEqual([]);
    const upload = good();
    upload.raster.scenes[0]!.render.uploadFrames.p95Ms = 0.4 + 2 + 0.6 + 0.1;
    expect(rasterBudgetProblems(upload).join()).toMatch(/upload frames|over upload frames/);
    const bytes = good();
    bytes.raster.scenes[0]!.uploads.overBudgetFrames = 1;
    expect(rasterBudgetProblems(bytes).join()).toMatch(/byte budget plus one tile/);
  });
  it("with fewer than 20 upload frames the bound is asserted on their p50, because their p95 is their max, and the hitch is still listed", () => {
    const few = good();
    const sc = few.raster.scenes[0]!;
    sc.render.uploadFrames = { frames: 8, share: 0.017, p50Ms: 3.9, p95Ms: 32.3, maxMs: 32.3, over16_7Ms: [32.3] };
    expect(rasterBudgetProblems(few), "a 32 ms hitch among 8 upload frames: p50 3.9 is inside 0.4 + 2 + 0.6").toEqual([]);
    expect(sc.render.uploadFrames.over16_7Ms).toEqual([32.3]);
    sc.render.uploadFrames.p50Ms = 3.2;
    expect(rasterBudgetProblems(few).join(), "p50 3.2 is over the bound of 3.0 ms").toMatch(/render p50 3\.2 ms over upload frames \(8\)/);
    const many = good();
    many.raster.scenes[0]!.render.uploadFrames = { frames: 20, share: 0.04, p50Ms: 1, p95Ms: 32.3, maxMs: 32.3, over16_7Ms: [32.3] };
    expect(rasterBudgetProblems(many).join(), "with 20 frames the p95 counts").toMatch(/render p95 32\.3 ms over upload frames \(20\)/);
  });
  it("refuse a result that does not list the frames over 16.7 ms", () => {
    const r = good();
    delete (r.raster.scenes[0]!.render.uploadFrames as { over16_7Ms?: unknown }).over16_7Ms;
    expect(validateRasterResult(r, false).join()).toMatch(/over16_7Ms/);
  });
  it("on an engine whose timer is clamped to 1 ms the steady mean is asserted, not the clamped p95", () => {
    const w = good();
    w.environment.timerResolutionMs = 1;
    w.raster.scenes[1]!.render.steady = { frames: 3300, meanMs: 1.2, p50Ms: 1, p95Ms: 2, p99Ms: 3, maxMs: 6, over16_7Ms: [] };
    expect(rasterBudgetProblems(w), "p95 reads 2 ms but the mean is 1.2 ms").toEqual([]);
    w.raster.scenes[1]!.render.steady.meanMs = 1.6;
    expect(rasterBudgetProblems(w).join()).toMatch(/steady render mean 1\.6/);
  });
  it("refuse a result with no timer resolution or no steady block", () => {
    const a = good();
    delete a.environment.timerResolutionMs;
    expect(validateRasterResult(a, false).join()).toMatch(/timerResolutionMs/);
    const b = good();
    delete (b.raster.scenes[0]!.render as { steady?: unknown }).steady;
    expect(validateRasterResult(b, false).join()).toMatch(/render\.steady/);
  });
});

describe("#108 raster baselines", () => {
  const b = json("bench/baselines/renderer-baselines.json");
  it("are valid", () => expect(validateBaselines(b)).toEqual([]));
  it("carry a raster entry for the three real renderers, each naming an existing result file", () => {
    const keys = Object.keys(b.rasterEntries ?? {});
    expect(keys.length).toBe(3);
    for (const k of keys) {
      const e = b.rasterEntries[k];
      expect(isSoftwareRenderer(k), k).toBe(false);
      expect(e.softwareRenderer, k).toBe(false);
      expect(existsSync(path.join(root, e.source)), k).toBe(true);
      expect(e.raster.decode.length, k).toBeGreaterThan(0);
    }
    expect(keys.map((k) => b.rasterEntries[k].engine).sort()).toEqual(["chromium", "chromium", "webkit"]);
  });
  it("hold the software rows apart, labelled no GPU, linux, and never as tuning input", () => {
    const keys = Object.keys(b.softwareRasterEntries ?? {});
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      const e = b.softwareRasterEntries[k];
      expect(isSoftwareRenderer(k), k).toBe(true);
      expect(e.container, k).toMatch(/no GPU/);
      expect(e.os, k).toMatch(/linux/i);
      expect(b.rasterEntries[k], k).toBeUndefined();
      expect(b.tunedFrom, k).not.toContain(k);
      expect(existsSync(path.join(root, e.source)), k).toBe(true);
    }
  });
  it("a 4K view of two scans stays inside gpuBytes on every real renderer", () => {
    for (const [k, e] of Object.entries<{ raster: RasterResult["raster"] }>(b.rasterEntries)) {
      const four = e.raster.fit.find((f) => f.view === "4k")!;
      expect(four.peakGpuTierBytes, k).toBeLessThanOrEqual(four.gpuBytes);
      expect(rasterBudgetProblems({ raster: e.raster }).filter((p) => /ceiling/.test(p)), k).toEqual([]);
    }
  });
  it("every real renderer meets the render budget of ADR 0009: steady frames at most 1.5 ms, upload frames inside the upload budget's rule", () => {
    for (const [k, e] of Object.entries<{ raster: RasterResult["raster"]; timerResolutionMs?: number }>(b.rasterEntries)) {
      expect(rasterBudgetProblems({ raster: e.raster, environment: { timerResolutionMs: e.timerResolutionMs } }), k).toEqual([]);
    }
  });
  it("the entry carries the timer resolution the statistic was chosen from, and WebKit's is the clamped one", () => {
    for (const [k, e] of Object.entries<{ engine: string; timerResolutionMs?: number }>(b.rasterEntries)) {
      expect(e.timerResolutionMs, k).toBeGreaterThan(0);
      if (e.engine === "webkit") expect(e.timerResolutionMs, k).toBeGreaterThanOrEqual(1);
    }
  });
  it("refuse a raster entry for a software renderer, and a software raster entry without the label", () => {
    const x = structuredClone(b);
    const k = Object.keys(x.softwareRasterEntries)[0]!;
    x.rasterEntries[k] = x.softwareRasterEntries[k];
    expect(validateBaselines(x).join()).toMatch(/software/);
    const y = structuredClone(b);
    delete y.softwareRasterEntries[k].container;
    expect(validateBaselines(y).join()).toMatch(/no GPU/);
  });
});

describe("#108 raster corpus cases", () => {
  const corpus = json("bench/corpus/corpus.json");
  const tiles = json("bench/hw/raster-tiles.json");
  it("carry the one scan and ten scan cases with their pinned digest", () => {
    expect(validateRasterCorpus(corpus, tiles)).toEqual([]);
    expect(corpus.rasterCases.map((c: { id: string }) => c.id)).toEqual(["architectural-1e5+1-scan", "architectural-1e5+10-scans"]);
    for (const c of corpus.rasterCases) {
      expect(c.scan.width).toBe(18724);
      expect(c.scan.height).toBe(13244);
      expect(c.scan.tilesSha256).toBe(tiles.tilesSha256);
    }
  });
  it("refuse a raster case whose digest is not the pinned one, or whose scan count is not 1 or 10", () => {
    const x = structuredClone(corpus);
    x.rasterCases[0].scan.tilesSha256 = "0".repeat(64);
    expect(validateRasterCorpus(x, tiles).join()).toMatch(/digest/);
    const y = structuredClone(corpus);
    y.rasterCases[1].scans = 7;
    expect(validateRasterCorpus(y, tiles).join()).toMatch(/scans/);
  });
  it("the manifest lists every variant at every tile size with a sha256", () => {
    for (const v of RASTER_VARIANTS) for (const e of RASTER_EDGES) {
      const t = tiles.tiles.find((x: { variant: string; edge: number }) => x.variant === v && x.edge === e);
      expect(t, `${v} ${e}`).toBeDefined();
      expect(t.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("#108 the texture constant", () => {
  it("lives in defaults.ts and release/v1-freeze.json, equal, and the equality turns red when one side moves", () => {
    const freeze = json("release/v1-freeze.json");
    const live = JSON.parse(JSON.stringify((defaults as unknown as Record<string, unknown>)["RASTER_DEFAULTS"]));
    expect(live).toBeDefined();
    expect(freeze.budgets.RASTER_DEFAULTS).toEqual(live);
    const moved = { ...freeze.budgets.RASTER_DEFAULTS, retainedLevelFactor: freeze.budgets.RASTER_DEFAULTS.retainedLevelFactor + 1 };
    expect(moved).not.toEqual(live);
  });
  it("is the one the renderer's budget formula reads: two tiles of a level for every tile in view, times the bytes of a texel", () => {
    const d = (defaults as unknown as { RASTER_DEFAULTS: { bytesPerTexel: number; retainedLevelFactor: number; textureShare: number } }).RASTER_DEFAULTS;
    const p: RasterPlacement = { id: 0, pixelToSource: [1, 0, 0, -1, 0, 1080], width: 1920, height: 1080, visibleBox: [0, 0, 1920, 1080], tileEdge: 512, levels: 3, codec: 1, channels: 4, bitDepth: 8, opacity: 255, band: 0 };
    const view = { sourceToDevice: [1, 0, 0, 1, 0, 0] as const, width: 1920, height: 1080 };
    const [f] = fitLevels([p], view, 1 << 30);
    expect(f!.tiles.length).toBeGreaterThan(0);
    // exactly the tier it would need at the default share: shrink the tier by one byte below the need and the level steps down
    const need = f!.tiles.length * d.retainedLevelFactor * 512 * 512 * d.bytesPerTexel;
    expect(fitLevels([p], view, need)[0]!.level).toBe(f!.level);
    expect(fitLevels([p], view, need - 1)[0]!.level).toBeLessThan(f!.level);
    expect(d.textureShare).toBeGreaterThan(0);
    expect(d.textureShare).toBeLessThanOrEqual(1);
  });
  it("the render budget is frozen with its renderers, equal to the constant the gate asserts, and names the three real renderers", () => {
    const freeze = json("release/v1-freeze.json");
    const rb = freeze.rasterProvenance?.renderBudget;
    expect(rb).toBeDefined();
    expect(rb.steadyP95Ms).toBe(RASTER_RENDER_STEADY_P95_MS);
    expect(rb.softwareFeedsBudget ?? freeze.rasterProvenance.softwareFeedsBudget).toBe(false);
    expect(rb.statistic).toMatch(/mean/);
    expect(rb.uploadFrames, "the 20-frame rule is written into the provenance, not left as a silent deviation").toMatch(/at least 20 upload frames.*p50/);
    const keys = Object.keys(json("bench/baselines/renderer-baselines.json").rasterEntries).sort();
    expect([...freeze.rasterProvenance.renderers].sort()).toEqual(keys);
  });
  it("every software GL provenance is called a relative cost in the freeze file and the changelog, and none feeds a budget", () => {
    const freeze = json("release/v1-freeze.json");
    const prov = JSON.stringify(freeze.rasterProvenance ?? {});
    expect(freeze.rasterProvenance).toBeDefined();
    expect(prov).not.toMatch(/swiftshader|llvmpipe/i);
    for (const k of freeze.rasterProvenance.renderers as string[]) expect(isSoftwareRenderer(k), k).toBe(false);
    expect(freeze.rasterProvenance.softwareFeedsBudget).toBe(false);
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toMatch(/raster.*texture constant|texture constant.*raster/is);
  });
});

describe("#108 generated pages", () => {
  const gen = generateDocs(root);
  const report = gen.get("docs/benchmark-report.md")!;
  const slo = gen.get("docs/slo.md")!;
  it("the report renders the raster section from the baselines, software rows labelled as relative costs", () => {
    expect(report).toMatch(/### Rasters through the wired layer/);
    expect(report).toMatch(/Decode per tile/);
    expect(report).toMatch(/software GL.*relative cost|relative cost.*software GL/i);
    const b = json("bench/baselines/renderer-baselines.json");
    for (const k of Object.keys(b.rasterEntries)) expect(report).toContain(k.split(" | ")[0]!);
  });
  it("slo.md renders the first drawing with a raster at 25 and 5 Mbit/s, recorded and not claimed", () => {
    expect(slo).toMatch(/with a raster/i);
    expect(slo).toMatch(/25 Mbit\/s/);
    expect(slo).toMatch(/5 Mbit\/s/);
    expect(slo).toMatch(/not claimed/i);
  });
  it("docs:check is red on a hand edit of either page", () => {
    for (const f of ["docs/benchmark-report.md", "docs/slo.md"]) {
      expect(readFileSync(path.join(root, f), "utf8"), f).toBe(gen.get(f));
      expect(readFileSync(path.join(root, f), "utf8") + "hand edit", f).not.toBe(gen.get(f));
    }
  });
});

describe("#108 the pinned ADR pointer", () => {
  it("ADR 0009 points at the measured constant with a date", () => {
    const adr = readFileSync(path.join(root, "docs/adr/0009-raster-quads.md"), "utf8");
    expect(adr).toMatch(/open question 5[^\n]*\n?[^\n]*20\d\d-\d\d-\d\d/is);
    expect(adr).toMatch(/RASTER_DEFAULTS/);
  });
});
