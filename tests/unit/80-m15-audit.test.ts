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

  // Measured with the writer's own leaf size (pvec halves it only to keep a block under 16 MiB): architectural-1e5 has 4 leaves whose boxes
  // overlap, so a 5 percent window still touches 3 of them (85 percent of the file, against the block directory's 96). architectural-1e6
  // has 31 leaves, and the same window reads 17 percent. The narrowing depends on the leaf count, and docs/deferred.md says so.
  const limits: Record<string, number> = { "architectural-1e5": 0.9, "architectural-1e6": 0.25 };
  for (const arch of ["x86_64", "arm64"]) {
    for (const [name, limit] of Object.entries(limits)) {
      it(`${arch}: a 5 percent window on ${name} reads under ${Math.round(limit * 100)} percent of the file, less than the 96 percent of the block directory`, () => {
        const runs = read<{ runs: Run[] }>(`spikes/pvec-real/range-results-${arch}.json`).runs;
        const run = runs.find((x) => x.name === name && x.rttMs === 0)!;
        expect(run.spatialDirectory, "the file carries a spatial directory the evaluator reads").toBe(true);
        const small = run.viewports.find((v) => v.preset === "small")!;
        expect(small.spatial, "the window is answered by the directory").toBeDefined();
        expect(small.spatial!.bytes / run.fileBytes).toBeLessThan(limit);
      });
    }
  }
});
