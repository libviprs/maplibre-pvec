import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config/defaults";
import { isSoftwareRenderer, uploadBytesWithin, validateBaselines, validateHardwareResult, type HardwareResult } from "../../bench/lib/hardware";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const json = (p: string) => JSON.parse(readFileSync(path.join(root, p), "utf8"));

const good = (): HardwareResult => ({
  schema: 1,
  commit: "abc1234",
  date: "2026-10-30T10:00:00.000Z",
  environment: {
    host: "test host", os: "macOS", arch: "arm64", cpu: "Apple M5", engine: "chromium", browserVersion: "149.0.0.0",
    gpuRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)", gpuVendor: "Google Inc. (Apple)",
    softwareRenderer: false, dpr: 2, viewport: [1600, 1000], timerQuery: true,
  },
  frames: { durationMs: 60000, count: 3600, p50Ms: 16.7, p95Ms: 17.1, p99Ms: 18, maxMs: 25, over20Ms: 0 },
  drawCalls: { perFrame: 10, segmentsPerFrame: 1_000_000 },
  cpu: { submitP50Ms: 0.2, submitP95Ms: 0.4, submitMaxMs: 1.1 },
  gpu: { frameP50Ms: 2, frameP95Ms: 3 },
  draw1e6: { segments: 1_000_000, uploadMs: 40, syncDrawP50Ms: 3, syncDrawP95Ms: 4 },
  upload: [{ bytes: 1 << 20, p50Ms: 0.3, p95Ms: 0.5 }, { bytes: 4 << 20, p50Ms: 1.2, p95Ms: 1.9 }, { bytes: 8 << 20, p50Ms: 2.4, p95Ms: 3.6 }],
  snapshot: { scene: "stroke-cross-v1", sha256: "0".repeat(64) },
});

describe("#82 software renderer detection", () => {
  it.each(["SwiftShader", "llvmpipe (LLVM 15.0.7, 256 bits)", "Google SwiftShader", "softpipe", "Software Rasterizer", "Mesa Software"])("%s is software", (s) => {
    expect(isSoftwareRenderer(s)).toBe(true);
  });
  it.each(["ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)", "Apple GPU", "ANGLE (Intel, Mesa Intel(R) UHD Graphics (ADL GT1), OpenGL 4.6)"])("%s is hardware", (s) => {
    expect(isSoftwareRenderer(s)).toBe(false);
  });
});

describe("#82 hardware result files", () => {
  it("accept a complete hardware result", () => expect(validateHardwareResult(good())).toEqual([]));
  it("reject a software renderer even when it claims to be hardware", () => {
    const r = good();
    r.environment.gpuRenderer = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)";
    expect(validateHardwareResult(r).join()).toMatch(/software/);
  });
  it("reject a run shorter than 60 s", () => {
    const r = good();
    r.frames.durationMs = 30000;
    expect(validateHardwareResult(r).join()).toMatch(/60/);
  });
  it("reject a 1e6 draw that drew fewer segments", () => {
    const r = good();
    r.draw1e6.segments = 500_000;
    expect(validateHardwareResult(r).join()).toMatch(/1e6|1000000/);
  });
  it("reject an unknown arch label", () => {
    const r = good();
    (r.environment as { arch: string }).arch = "x86_64 under rosetta";
    expect(validateHardwareResult(r).join()).toMatch(/arch/);
  });
});

const goodLayer = (): NonNullable<HardwareResult["layer"]> => ({
  durationMs: 60000, segments: 1_000_000, stateDiffs: 0, errors: 0,
  frames: { count: 3600, p50Ms: 16.7, p95Ms: 17.2, p99Ms: 18, maxMs: 25, over20Ms: 0 },
  drawCalls: { perFrame: 10 },
  cpu: { renderP50Ms: 0.2, renderP95Ms: 0.4, renderMaxMs: 1.1 },
  gpu: { frameP50Ms: 2, frameP95Ms: 3 },
  settle: { frames: 12, ms: 300, renderMaxMs: 3 },
});

describe("#82 layer runs (the wired custom layer on a real map)", () => {
  it("accept a complete layer block", () => expect(validateHardwareResult({ ...good(), layer: goodLayer() })).toEqual([]));
  it("accept a result with no layer block (the raw pipeline run)", () => expect(validateHardwareResult(good())).toEqual([]));
  it("reject a layer run shorter than 60 s", () => {
    expect(validateHardwareResult({ ...good(), layer: { ...goodLayer(), durationMs: 20000 } }).join()).toMatch(/layer.*60/);
  });
  it("reject a layer run that drew fewer than 1e6 segments", () => {
    expect(validateHardwareResult({ ...good(), layer: { ...goodLayer(), segments: 1000 } }).join()).toMatch(/layer.*1e6/);
  });
  it("reject a layer run with no draw calls", () => {
    expect(validateHardwareResult({ ...good(), layer: { ...goodLayer(), drawCalls: { perFrame: 0 } } }).join()).toMatch(/layer.*drawCalls/);
  });
  it("reject a layer run that left GL state behind or raised an error", () => {
    expect(validateHardwareResult({ ...good(), layer: { ...goodLayer(), stateDiffs: 2 } }).join()).toMatch(/layer.*state/);
    expect(validateHardwareResult({ ...good(), layer: { ...goodLayer(), errors: 1 } }).join()).toMatch(/layer.*error/);
  });
  it("reject a layer run with a missing CPU number", () => {
    const l = goodLayer() as unknown as { cpu: Record<string, number> };
    delete l.cpu.renderP95Ms;
    expect(validateHardwareResult({ ...good(), layer: l as never }).join()).toMatch(/layer.*cpu/);
  });
});

describe("#82 upload budget derivation", () => {
  const curve = good().upload;
  it("is the largest measured size whose p95 fits the time budget", () => {
    expect(uploadBytesWithin(curve, 2)).toBe(4 << 20);
    expect(uploadBytesWithin(curve, 4)).toBe(8 << 20);
    expect(uploadBytesWithin(curve, 0.1)).toBe(0);
  });
});

describe("#82 renderer-keyed baselines", () => {
  const baselines = json("bench/baselines/renderer-baselines.json");
  it("are valid and keyed by the renderer string", () => expect(validateBaselines(baselines)).toEqual([]));
  it("hold at least one real-hardware entry and no software entry", () => {
    const keys = Object.keys(baselines.entries);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(isSoftwareRenderer(k)).toBe(false);
      expect(baselines.entries[k].softwareRenderer).toBe(false);
    }
  });
  it("name the result file each entry came from, and that file exists", () => {
    for (const e of Object.values<{ source: string }>(baselines.entries)) expect(existsSync(path.join(root, e.source))).toBe(true);
  });
});

describe("#82 retuned budgets", () => {
  const baselines = json("bench/baselines/renderer-baselines.json");
  const freeze = json("release/v1-freeze.json");
  it("defaults.ts and release/v1-freeze.json carry the same pool budgets", () => {
    for (const k of ["uploadBudgetBytes", "uploadBudgetMs", "arenaPageBytes"] as const) expect(freeze.budgets.DEFAULTS[k]).toBe(DEFAULTS[k]);
  });
  it("the upload byte budget fits uploadBudgetMs on every hardware entry", () => {
    for (const [k, e] of Object.entries<{ upload: HardwareResult["upload"] }>(baselines.entries)) {
      expect(uploadBytesWithin(e.upload, DEFAULTS.uploadBudgetMs), k).toBeGreaterThanOrEqual(DEFAULTS.uploadBudgetBytes);
    }
  });
  it("every tuning entry carries a layer run with ten draw calls and a held 1e6-segment frame", () => {
    for (const k of baselines.tunedFrom) {
      const l = baselines.entries[k].layer;
      expect(l, k).toBeDefined();
      expect(l.drawCalls.perFrame, k).toBe(10);
      expect(l.segments, k).toBeGreaterThanOrEqual(1_000_000);
      expect(l.stateDiffs, k).toBe(0);
    }
  });
  it("records which hardware the budgets were tuned on", () => {
    expect(baselines.tunedFrom.length).toBeGreaterThan(0);
    for (const k of baselines.tunedFrom) expect(baselines.entries[k]).toBeDefined();
  });
});
