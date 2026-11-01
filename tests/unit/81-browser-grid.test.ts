import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { COMPAT } from "../../src/compat/matrix";
import { buildGate } from "../../tools/release-gate.mjs";

// Issue 81. The matrix may only claim what the grid evidence shows, and the evidence file is written
// by tools/browser-grid.mjs from the Playwright report of the grid run, never by hand.
interface Run { engine: string; version: string; kind: "grid" | "isolated"; maplibre?: string; total: number; passed: number }
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const evidence = (): { arch: string; runs: Run[] } => JSON.parse(read("release/browser-grid.json"));
const grid = (e: string) => evidence().runs.filter((r) => r.engine === e && r.kind === "grid");
const num = (v: string) => Number(v.split(".")[0]);

describe("#81 browser grid evidence", () => {
  it("exists and every run in it passed every test", () => {
    expect(existsSync(new URL("../../release/browser-grid.json", import.meta.url))).toBe(true);
    for (const r of evidence().runs) {
      expect(r.total, `${r.engine} ${r.version} ${r.maplibre ?? ""}`).toBeGreaterThan(0);
      expect(r.passed, `${r.engine} ${r.version} ${r.maplibre ?? ""}`).toBe(r.total);
    }
  });

  it("covers every browser engine against the lowest and the highest tested MapLibre", () => {
    const ml = COMPAT.maplibre.map((m) => m.version);
    for (const b of COMPAT.browsers) {
      const seen = new Set(grid(b.engine).map((r) => r.maplibre));
      expect([...seen], b.engine).toEqual(expect.arrayContaining([ml[0], ml[ml.length - 1]]));
    }
  });

  it("has a Chromium run below 130 as well as the pinned 130", () => {
    const majors = grid("chromium").map((r) => num(r.version));
    expect(Math.min(...majors)).toBeLessThan(130);
    expect(majors).toContain(130);
  });

  it("has an informational COOP/COEP isolated run for every engine", () => {
    for (const b of COMPAT.browsers) {
      expect(evidence().runs.filter((r) => r.engine === b.engine && r.kind === "isolated").length, b.engine).toBeGreaterThan(0);
    }
  });
});

describe("#81 the matrix claims only what the grid measured", () => {
  it("has no pending browser row left", () => {
    expect(COMPAT.browsers.filter((b) => b.status === "pending").map((b) => b.engine)).toEqual([]);
  });

  it("states for each supported row a tested version that the evidence contains", () => {
    for (const b of COMPAT.browsers.filter((x) => x.status === "supported")) {
      expect(grid(b.engine).map((r) => r.version), b.engine).toContain(b.tested);
    }
  });

  it("states the lowest passing Chromium version, not just the pinned one", () => {
    const low = Math.min(...grid("chromium").map((r) => num(r.version)));
    expect(num(COMPAT.browsers.find((b) => b.engine === "chromium")!.tested)).toBe(low);
  });

  it("flips the freeze row exactly when every row is supported and the grid evidence is green", () => {
    const c = (buildGate().conditions as Array<{ id: string; status: string; measured: unknown }>).find((x) => x.id === "conformance_green_every_browser_row")!;
    expect(c.status).toBe("met");
    expect(c.measured).toMatchObject({ supportedRows: 3, rows: 3 });
  });
});
