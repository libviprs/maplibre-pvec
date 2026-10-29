import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildApiReport, ENTRIES } from "../../../tools/api-report.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string): string => readFileSync(path.join(root, p), "utf8");

describe("#26 M7.1 public surface", () => {
  const report = buildApiReport(root);

  it("docs/api/public-surface.md lists every value export of each entry and nothing else", async () => {
    const doc = read("docs/api/public-surface.md");
    for (const [entry, file] of Object.entries(ENTRIES)) {
      const mod = (await import(path.join(root, file))) as Record<string, unknown>;
      const section = doc.split(/^## Entry /m).find((s) => s.startsWith(`\`${entry}\``)) ?? "";
      const rows = [...section.matchAll(/^\| `(\w+)` \| (value|type) \|/gm)].map((m) => [m[1], m[2]] as const);
      const docValues = rows.filter((r) => r[1] === "value").map((r) => r[0]).sort();
      const docTypes = rows.filter((r) => r[1] === "type").map((r) => r[0]).sort();
      expect(docValues, `value names of ${entry}`).toEqual(Object.keys(mod).sort());
      expect(docTypes, `type names of ${entry}`).toEqual(report.entries[entry]!.types.slice().sort());
    }
  });

  it("the committed API report equals the regenerated one", () => {
    expect(read("etc/maplibre-pvec.api.md")).toBe(report.text);
  });

  it("does not export the internals the issue names", async () => {
    const mod = (await import("../../../src/index")) as Record<string, unknown>;
    for (const n of ["PVecSource", "TieredCache", "RangeScheduler", "BufferPool", "GlStateGuard", "Tier0Decoder", "bootstrap"]) {
      expect(Object.keys(mod), n).not.toContain(n);
    }
    expect(report.entries["."]!.types.some((t) => /wasm|worker.?message|layout/i.test(t))).toBe(false);
  });

  it("the declarations carry no any and import nothing from outside the package", () => {
    expect(report.text).not.toMatch(/\bany\b/);
    for (const m of report.text.matchAll(/from "([^"]+)"/g)) {
      expect(m[1]!.startsWith(".") || m[1] === "maplibre-gl", m[1]).toBe(true);
    }
  });

  it("the only WebGPU name is experimental.webgpu, typed as unsupported", () => {
    const hits = [...report.text.matchAll(/\w*webgpu\w*/gi)].map((m) => m[0]);
    expect(new Set(hits)).toEqual(new Set(["webgpu"]));
    expect(report.text).toMatch(/experimental\?: \{\s*readonly webgpu\?: false;?\s*\}/);
    expect(report.text).not.toContain("SharedArrayBuffer");
  });

  it("importing the entry points does no network, builds no Worker and no GL context", async () => {
    const calls: string[] = [];
    const stub = (n: string) =>
      function (this: unknown) {
        calls.push(n);
      };
    vi.stubGlobal("fetch", stub("fetch"));
    vi.stubGlobal("Worker", stub("Worker"));
    vi.stubGlobal("WebGLRenderingContext", stub("WebGLRenderingContext"));
    vi.stubGlobal("WebGL2RenderingContext", stub("WebGL2RenderingContext"));
    vi.stubGlobal("XMLHttpRequest", stub("XMLHttpRequest"));
    vi.resetModules();
    try {
      for (const file of Object.values(ENTRIES)) await import(path.join(root, file));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toEqual([]);
  });
});
