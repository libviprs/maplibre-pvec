import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = <T>(p: string): T => JSON.parse(readFileSync(join(root, p), "utf8")) as T;

interface Run {
  name: string;
  fileBytes: number;
  rttMs: number;
  spatialDirectory?: boolean;
  viewports: { preset: string; bytes: number; spatial?: { cells: number; bytes: number } }[];
}
interface Audit {
  tier0Stream?: { id: string; coverageMissing: number; previews: { withinDeclared: boolean }[] }[];
}

describe("#80 M1.5 audit with the real Tier 0 stream and the spatial directory", () => {
  it("results.json carries a Tier 0 stream audit with no missing coverage and every preview within its declared error", () => {
    const r = read<Audit>("spikes/pvec-real/results.json");
    expect(r.tier0Stream, "re-run spikes/pvec-real against the stream").toBeDefined();
    expect(r.tier0Stream!.length).toBeGreaterThan(0);
    for (const e of r.tier0Stream!) {
      expect(e.coverageMissing, e.id).toBe(0);
      for (const p of e.previews) expect(p.withinDeclared, e.id).toBe(true);
    }
  });

  for (const arch of ["x86_64", "arm64"]) {
    it(`${arch}: a 5 percent window on architectural-1e5 reads far less than the 96 percent of the block directory`, () => {
      const runs = read<{ runs: Run[] }>(`spikes/pvec-real/range-results-${arch}.json`).runs;
      const run = runs.find((x) => x.name === "architectural-1e5" && x.rttMs === 0)!;
      expect(run.spatialDirectory, "the file carries a spatial directory the evaluator reads").toBe(true);
      const small = run.viewports.find((v) => v.preset === "small")!;
      expect(small.spatial, "the window is answered by the directory").toBeDefined();
      const fraction = small.spatial!.bytes / run.fileBytes;
      expect(fraction).toBeLessThan(0.5);
      // The old number this replaces.
      expect(fraction).toBeLessThan(0.96);
    });
  }
});
