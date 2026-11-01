import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Tier0Decoder } from "../../src/decode/tier0";
import { tier0CursorOver } from "../../src/layer/tier0-cursor";
import { loadEvaluator } from "../../src/wasm/loader";
import { EVALUATOR_WASM_BYTES } from "./helpers/probe";

// Issue 148: the cursor the refinement runs on. A tolerance asked for in source units tessellates every entity of the window at that
// tolerance and ignores the stored previews, so the module (not this add-on) decides how many vertices a finer tolerance needs.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bytes = (id: string): Uint8Array => new Uint8Array(readFileSync(join(root, "tests/fixtures/pvec", `${id}.pvec`)));
const WORLD: [number, number, number, number] = [-1e6, -1e6, 1e6, 1e6];

async function draws(id: string, tolerance: number | undefined) {
  const evaluator = await loadEvaluator({ wasmModule: await WebAssembly.compile(EVALUATOR_WASM_BYTES) });
  const cursor = tier0CursorOver(evaluator, bytes(id), WORLD, tolerance === undefined ? undefined : { tolerance });
  try {
    return new Tier0Decoder().decodeAll(cursor);
  } finally {
    cursor.close();
  }
}
const vertices = (d: Awaited<ReturnType<typeof draws>>) => d.reduce((n, e) => n + (e.geometry.type === "polyline" || e.geometry.type === "line" ? e.geometry.points.length / 2 : 0), 0);

describe("#148 tier0CursorOver with a tolerance", () => {
  for (const id of ["circle-001", "bezier-d3-001", "nurbs-d3-001"]) {
    it(`${id}: a tolerance a hundred times finer gives more vertices, and the default is unchanged`, async () => {
      const dflt = await draws(id, undefined);
      const coarse = await draws(id, 0.1);
      const fine = await draws(id, 0.001);
      expect(vertices(fine)).toBeGreaterThan(vertices(coarse));
      expect(vertices(dflt)).toBeGreaterThan(0);
      for (const d of fine) expect(d.kind).toBe("preview");
    });
  }

  it("a straight line is the same two points at any tolerance", async () => {
    const a = await draws("line-001", 0.1);
    const b = await draws("line-001", 0.0001);
    expect(a.map((d) => d.geometry)).toEqual(b.map((d) => d.geometry));
  });
});
