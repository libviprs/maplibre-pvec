import { describe, expect, it } from "vitest";
import { checkVariance, relativeSpread } from "../../bench/lib/stats";
import { evaluateMetrics, validateResult, type BenchResult, type Metric } from "../../bench/lib/result";

const env = {
  browser: "chromium",
  browserVersion: "130.0.0.0",
  cpu: "test cpu",
  gpuRenderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)",
  softwareRenderer: true,
  crossOriginIsolated: false,
  platform: "linux/x86_64 native",
};
const metric: Metric = { case: "line-001", name: "p95_frame_ms", value: 12, baseline: 11, threshold: { op: "<=", limit: 16.7 } };
const good = (): BenchResult => ({
  schema: 1,
  commit: "abc1234",
  date: "2026-10-29T10:00:00.000Z",
  environment: structuredClone(env),
  corpus: { file: "bench/corpus/corpus.json", cases: 1 },
  subject: "map without add-on",
  runs: { "line-001": { first_useful_drawing_ms: [100, 101, 99, 100, 102], p95_frame_ms: [12, 12.1, 11.9, 12, 12.2] } },
  variance: { limit: 0.15, ok: true, failures: [] },
  metrics: [structuredClone(metric)],
});

describe("#34 variance", () => {
  it("is the sample standard deviation over the mean", () => {
    expect(relativeSpread([10, 10, 10])).toBe(0);
    expect(relativeSpread([8, 10, 12])).toBe(0.2);
  });
  it("fails when either named metric of any case exceeds 15 percent", () => {
    const ok = checkVariance({ "a/first_useful_drawing_ms": [100, 101, 99, 100, 100], "a/p95_frame_ms": [16, 16, 17, 16, 16] }, 0.15);
    expect(ok.ok).toBe(true);
    const bad = checkVariance({ "a/first_useful_drawing_ms": [100, 101, 99, 100, 100], "a/p95_frame_ms": [10, 20, 10, 25, 10] }, 0.15);
    expect(bad.ok).toBe(false);
    expect(bad.failures.join()).toMatch(/a\/p95_frame_ms/);
  });
  it("needs five runs", () => {
    expect(checkVariance({ "a/x": [1, 1, 1, 1] }, 0.15).ok).toBe(false);
  });
});

describe("#34 result files", () => {
  it("accept a complete result", () => {
    expect(validateResult(good())).toEqual([]);
  });
  it("reject a missing environment block", () => {
    const r = good() as unknown as Record<string, unknown>;
    delete r.environment;
    expect(validateResult(r).join()).toMatch(/environment/);
  });
  it.each(["browser", "browserVersion", "cpu", "gpuRenderer", "crossOriginIsolated", "platform"])("reject an environment without %s", (k) => {
    const r = good();
    delete (r.environment as unknown as Record<string, unknown>)[k];
    expect(validateResult(r).join()).toMatch(new RegExp(k));
  });
  it("require arm64 or native x86_64, never Rosetta", () => {
    for (const p of ["linux/arm64", "linux/x86_64 native"]) {
      const r = good();
      r.environment.platform = p;
      expect(validateResult(r)).toEqual([]);
    }
    for (const p of ["darwin/x86_64 rosetta", "linux/x86_64", "linux/riscv64"]) {
      const r = good();
      r.environment.platform = p;
      expect(validateResult(r).join(), p).toMatch(/platform/);
    }
  });
  it("label a software renderer, and refuse an unlabelled one", () => {
    const r = good();
    r.environment.softwareRenderer = false;
    expect(validateResult(r).join()).toMatch(/software/);
  });
  it("reject a metric missing its case, baseline or threshold", () => {
    for (const k of ["case", "baseline", "threshold"] as const) {
      const r = good();
      delete (r.metrics[0] as unknown as Record<string, unknown>)[k];
      expect(validateResult(r).join(), k).toMatch(new RegExp(k));
    }
  });
  it("refuse to pass a result whose variance check failed", () => {
    const r = good();
    r.variance = { limit: 0.15, ok: false, failures: ["x"] };
    expect(validateResult(r).join()).toMatch(/variance/);
  });
});

describe("#34 gate evaluation", () => {
  it("names the case and the measured value on a breach", () => {
    const m = { ...metric, value: 20 };
    const out = evaluateMetrics([m]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("line-001");
    expect(out[0]).toContain("20");
    expect(out[0]).toContain("p95_frame_ms");
  });
  it("supports >= and informational metrics", () => {
    expect(evaluateMetrics([{ ...metric, value: 60, threshold: { op: ">=", limit: 70 } }])).toHaveLength(1);
    expect(evaluateMetrics([{ ...metric, value: 80, threshold: { op: ">=", limit: 70 } }])).toEqual([]);
    expect(evaluateMetrics([{ ...metric, value: 1e9, threshold: { op: "info" } }])).toEqual([]);
  });
});
