import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const results = JSON.parse(readFileSync(join(root, "spikes/pvec-real/results.json"), "utf8")) as {
  pvecCommit: string;
  abiVersion: number;
  tier0Slices?: { id: string; entities: number; slices: number; maxSliceMs: number; totalMs: number; platform: string }[];
};

describe("#80 Tier 0 slice timing on the real stream", () => {
  it("spikes/pvec-real/results.json records the slices of the medium fixture", () => {
    expect(results.tier0Slices, "re-run spikes/pvec-real with the Tier 0 stream").toBeDefined();
    const medium = results.tier0Slices!.find((s) => s.id === "architectural-1e5");
    expect(medium, "architectural-1e5 is the medium fixture").toBeDefined();
    expect(medium!.entities).toBe(100000);
    expect(medium!.slices).toBeGreaterThan(1);
  });

  it("no single slice is above 8 ms (DEFAULTS.maxSliceMs)", () => {
    const medium = results.tier0Slices?.find((s) => s.id === "architectural-1e5");
    expect(medium?.maxSliceMs).toBeDefined();
    expect(medium!.maxSliceMs).toBeLessThanOrEqual(8);
  });

  it("was measured on the abi version the evaluator ships with the Tier 0 stream (2)", () => {
    expect(results.abiVersion).toBeGreaterThanOrEqual(2);
  });
});
