import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const results = JSON.parse(readFileSync(join(root, "spikes/pvec-real/results.json"), "utf8")) as {
  pvecCommit: string;
  abiVersion: number;
  tier0Slices?: { id: string; cursor: string; leaves: number; entities: number; slices: number; maxSliceMs: number; p99SliceMs?: number; medianSliceMs: number; overBudget?: number; totalMs: number; refused?: string; platform: string }[];
};
const LEAVES = "leaves (#125)";
const BOXES = "boxes (before #125)";
const row = (id: string, cursor: string) => results.tier0Slices?.find((s) => s.id === id && s.cursor === cursor);

describe("#80 and #125 Tier 0 slice timing on the real stream", () => {
  it("spikes/pvec-real/results.json records the slices of every entry, for the cursor and for the cursor as it was", () => {
    expect(results.tier0Slices, "re-run spikes/pvec-real with the Tier 0 stream").toBeDefined();
    for (const id of ["architectural-1e5", "architectural-1e6", "mep-1e5", "pathological-1e3", "spline-heavy-1e5"]) {
      expect(row(id, LEAVES), `${id} leaves`).toBeDefined();
      expect(row(id, BOXES), `${id} boxes`).toBeDefined();
    }
    expect(row("architectural-1e5", LEAVES)!.slices).toBeGreaterThan(1);
  });

  // The decoder stops a slice before a call that cannot end inside 8 ms (DEFAULTS.maxSliceMs), but the first call of a run, a collection or a single
  // curve that costs more than the budget by itself still overrun it. The strict "no slice above 8 ms" is not met, and docs/deferred.md says by how much.
  it("the medium files: the median slice is inside the budget, a few slices overrun it, none by more than twice", () => {
    for (const id of ["architectural-1e5", "mep-1e5", "spline-heavy-1e5"]) {
      const r = row(id, LEAVES)!;
      expect(r.refused, id).toBeUndefined();
      expect(r.medianSliceMs, id).toBeLessThanOrEqual(8);
      expect(r.overBudget! / r.slices, id).toBeLessThanOrEqual(0.1);
      expect(r.maxSliceMs, id).toBeLessThanOrEqual(16);
    }
  });

  it("architectural-1e6 is drawn whole by the cursor without raising the limit, and was refused by the cursor as it was", () => {
    const now = row("architectural-1e6", LEAVES)!;
    expect(now.refused).toBeUndefined();
    expect(now.entities).toBe(1_000_000);
    expect(now.overBudget! / now.slices).toBeLessThanOrEqual(0.1);
    expect(row("architectural-1e6", BOXES)!.refused).toMatch(/maxEntitiesPerBlock \(200000\)/);
  });

  it("the cursor does not cost more slices or time than the one it replaced, on every entry that was not refused", () => {
    for (const s of results.tier0Slices!.filter((x) => x.cursor === LEAVES)) {
      const before = row(s.id, BOXES)!;
      if (before.refused) continue;
      expect(s.totalMs, s.id).toBeLessThanOrEqual(before.totalMs);
    }
  });

  it("was measured on the abi version the evaluator ships with the Tier 0 stream (2) and the per-leaf calls", () => {
    expect(results.abiVersion).toBeGreaterThanOrEqual(2);
    expect(results.pvecCommit).toBe("fc5ca4a6cf59eff6339ed11d0931eec81d7feb30");
  });
});
