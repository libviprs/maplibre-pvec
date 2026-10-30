import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Tier0Decoder } from "../../src/decode/tier0";
import { engineDepsOf } from "../../src/layer/internal";
import { loadEvaluator } from "../../src/wasm/loader";
import { PVecSource } from "../../src/source/PVecSource";
import { BOOTSTRAP_MAX_REQUESTS } from "../../src/source/bootstrap";
import { EVALUATOR_WASM_BYTES } from "./helpers/probe";
import { RangeOrigin, countingFetch } from "./helpers/origin";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bytes = (id: string): Uint8Array => new Uint8Array(readFileSync(join(root, "tests/fixtures/pvec", `${id}.pvec`)));
// Known-truth fixtures whose strokes the default cursor must produce, no stand-ins.
const KNOWN_TRUTH = ["line-001", "polyline-001", "circle-001", "bezier-d3-001", "nurbs-d3-001"];

let origin: RangeOrigin | undefined;
afterEach(async () => origin?.stop());

async function open(id: string) {
  origin = new RangeOrigin(bytes(id));
  const url = `${await origin.start()}/p.pvec`;
  const c = countingFetch();
  const handle = await new PVecSource({ url, fetch: c.fetch }).bootstrap();
  const evaluator = await loadEvaluator({ wasmModule: await WebAssembly.compile(EVALUATOR_WASM_BYTES) });
  // The default dependency set of a layer nobody configured: this is what an installed layer runs.
  return { handle, evaluator, deps: engineDepsOf({}), log: origin.log, calls: c.calls, fileBytes: bytes(id).length };
}

describe("#80 the layer's default openCursor reads the real Tier 0 stream", () => {
  for (const id of KNOWN_TRUTH) {
    it(`${id}: returns a cursor and the decoder draws strokes from the evaluator's own bytes`, async () => {
      const { handle, evaluator, deps } = await open(id);
      const cursor = await deps.openCursor(handle, evaluator);
      expect(cursor, "default openCursor must not return null once the evaluator has a Tier 0 stream").not.toBeNull();
      const draws = new Tier0Decoder().decodeAll(cursor!);
      expect(draws.length).toBeGreaterThan(0);
      for (const d of draws) {
        expect(d.generation).toBe(0);
        expect(d.bounds.maxX).toBeGreaterThanOrEqual(d.bounds.minX);
      }
    });

    it(`${id}: the request log holds the bootstrap and the Tier 0 ranges only, all inside the file`, async () => {
      const { handle, evaluator, deps, log, calls, fileBytes } = await open(id);
      const cursor = await deps.openCursor(handle, evaluator);
      expect(cursor).not.toBeNull();
      new Tier0Decoder().decodeAll(cursor!);
      expect(log.length).toBeGreaterThan(0);
      for (const r of log) {
        expect(r.method).toBe("GET");
        expect(r.range, "every request is a byte range, never the whole file").toMatch(/^bytes=\d+-\d+$/);
        const [a, b] = r.range!.slice(6).split("-").map(Number) as [number, number];
        expect(b).toBeLessThan(fileBytes);
        expect(a).toBeLessThanOrEqual(b);
      }
      // Bootstrap is at most three requests; the Tier 0 chunks the directory lists come on top and nothing else.
      const tier0Chunks = handle.directory.entries.length;
      expect(calls.length).toBeLessThanOrEqual(BOOTSTRAP_MAX_REQUESTS + tier0Chunks);
    });
  }

  it("the evaluator, not the TypeScript, decodes: no polyline in the map spec harness is needed", () => {
    const harness = readFileSync(join(root, "tests/e2e/harness/layer-entry.ts"), "utf8");
    expect(harness, "the map specs inject no cursor of their own any more").not.toMatch(/openCursor:/);
  });
});
