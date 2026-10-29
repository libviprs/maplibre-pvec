import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as defaults from "../../src/config/defaults";
import { buildApiReport } from "../../tools/api-report.mjs";
import { REQUIRED_CONDITIONS, apiSymbols, buildGate, classifyApiChange, evaluateRelease, sha256 } from "../../tools/release-gate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const json = (p: string) => JSON.parse(readFileSync(path.join(root, p), "utf8"));

describe("#40 v1 freeze", () => {
  const freeze = json("release/v1-freeze.json");

  it("freezes the budgets by equality with defaults.ts", () => {
    const live = {
      DEFAULTS: defaults.DEFAULTS,
      DISPLAY_FIDELITY_TARGET_PX: defaults.DISPLAY_FIDELITY_TARGET_PX,
      MAX_SUBDIVISION_DEPTH: defaults.MAX_SUBDIVISION_DEPTH,
      PRECISION_ENVELOPE: defaults.PRECISION_ENVELOPE,
      REFINE_DEFAULTS: defaults.REFINE_DEFAULTS,
      QUEUE_DEFAULTS: defaults.QUEUE_DEFAULTS,
      CACHE_DEFAULTS: defaults.CACHE_DEFAULTS,
      POOL_DEFAULTS: defaults.POOL_DEFAULTS,
    };
    expect(freeze.budgets).toEqual(JSON.parse(JSON.stringify(live)));
  });

  it("freezes compatibility.json: one baseline projection, WebGPU not a browser row, no SAB requirement", () => {
    const compat = json("compatibility.json");
    expect(compat.projections.filter((p: { baseline: boolean }) => p.baseline).map((p: { id: string }) => p.id)).toEqual(["mercator"]);
    expect(freeze.conformanceProjection).toBe("mercator");
    expect(freeze.compatibility.peerRange).toBe(compat.peerDependency["maplibre-gl"]);
    expect(freeze.compatibility.pvec).toEqual(compat.pvec);
    expect(JSON.stringify(compat.browsers)).not.toMatch(/webgpu/i);
    expect(compat.browserRequirements.crossOriginIsolation).toMatch(/never required/);
    expect(freeze.webgpu).toBe("experimental");
    expect(freeze.sharedArrayBuffer).toBe("optional");
  });

  it("pins the API report: hash and per-symbol table match the committed report", () => {
    const report = readFileSync(path.join(root, "etc/maplibre-pvec.api.md"), "utf8");
    expect(buildApiReport(root).text).toBe(report);
    expect(freeze.api.reportSha256).toBe(sha256(report));
    expect(freeze.api.symbols).toEqual(apiSymbols(report));
  });

  it("classifies surface changes by the semver rules", () => {
    const base = { ".": { a: "h1", b: "h2" } };
    expect(classifyApiChange(base, base)).toBe("none");
    expect(classifyApiChange(base, { ".": { a: "h1", b: "h2", c: "h3" } })).toBe("minor");
    expect(classifyApiChange(base, { ".": { a: "h1" } })).toBe("major");
    expect(classifyApiChange(base, { ".": { a: "h1", b: "changed" } })).toBe("major");
    expect(classifyApiChange(base, { ".": { a: "h1", b: "changed", c: "h3" } })).toBe("major");
    expect(freeze.semver).toEqual({ additions: "minor", removalsOrSignatureChanges: "major" });
  });

  it("the committed surface is the frozen one", () => {
    expect(classifyApiChange(freeze.api.symbols, apiSymbols(readFileSync(path.join(root, "etc/maplibre-pvec.api.md"), "utf8")))).toBe("none");
  });
});

describe("#40 v1 gate", () => {
  const gate = json("release/v1-gate.json");

  it("has one entry per freeze condition, each with a measured value and evidence", () => {
    expect(REQUIRED_CONDITIONS).toHaveLength(7);
    for (const id of REQUIRED_CONDITIONS) {
      const e = gate.conditions.find((c: { id: string }) => c.id === id);
      expect(e, id).toBeDefined();
      expect(["met", "deferred"]).toContain(e.status);
      expect(e.measured).not.toBeUndefined();
      expect(String(e.evidence).length).toBeGreaterThan(10);
      if (e.status === "deferred") expect(e.deferredIn).toMatch(/^docs\/deferred\.md#/);
    }
  });

  it("is what buildGate computes from the tree", () => {
    expect(buildGate(root)).toEqual(gate);
  });

  it("refuses the tag while a condition is deferred, and when an entry is removed", () => {
    expect(evaluateRelease(gate).ok).toBe(false);
    const green = { conditions: REQUIRED_CONDITIONS.map((id: string) => ({ id, status: "met", measured: 1, evidence: "synthetic evidence" })) };
    expect(evaluateRelease(green).ok).toBe(true);
    const missing = { conditions: green.conditions.slice(1) };
    const r = evaluateRelease(missing);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain(REQUIRED_CONDITIONS[0]);
  });

  it("does not tag: the package stays private and unversioned", () => {
    const pkg = json("package.json");
    expect(pkg.private).toBe(true);
    expect(pkg.version).toBe("0.0.0");
    expect(existsSync(path.join(root, "CHANGELOG.md"))).toBe(true);
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toMatch(/Unreleased/);
  });
});
