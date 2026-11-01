import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tier0CursorOver } from "../../src/layer/tier0-cursor";
import { loadEvaluator, type Evaluator } from "../../src/wasm/loader";
import { bindPacked } from "../../src/wasm/packed";
import { EVALUATOR_WASM_BYTES } from "./helpers/probe";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// pathological-1e3 (917 entities) written with a leaf capacity of 100: eight leaves, and the advanced curves
const file = new Uint8Array(readFileSync(join(root, "tests/fixtures/pvec-leaves", "leaf100.pvec")));

afterEach(() => vi.restoreAllMocks());

function extent(ev: Evaluator): [number, number, number, number] {
  const rt = bindPacked(ev);
  const f = rt.open(file);
  const b = [0, 1, 2, 3].map((n) => rt.directoryBound(f, n)) as [number, number, number, number];
  rt.release(f);
  return b;
}

describe("#141 the cursor does not hold the id of every entity of the file", () => {
  it("no Set grows past the size of a leaf while a file of eight leaves is walked (a Set rehashes in one go when it doubles)", async () => {
    const ev = await loadEvaluator({ wasmModule: await WebAssembly.compile(EVALUATOR_WASM_BYTES) });
    const ext = extent(ev);
    let largest = 0;
    const add = Set.prototype.add;
    vi.spyOn(Set.prototype, "add").mockImplementation(function (this: Set<unknown>, v: unknown) {
      const r = add.call(this, v);
      largest = Math.max(largest, this.size);
      return r;
    });
    const cursor = tier0CursorOver(ev, file, ext);
    const ids: string[] = [];
    for (let guard = 0; guard < 1e5; guard++) {
      const batch = cursor.next(8);
      if (batch === null) break;
      ids.push(...batch.map((e) => e.entityId));
    }
    expect(ids.length, "entities answered").toBeGreaterThan(800);
    expect(largest, "the largest Set while walking").toBeLessThanOrEqual(200);
  });

  it("every entity is still answered once (guard, green before the fix)", async () => {
    const ev = await loadEvaluator({ wasmModule: await WebAssembly.compile(EVALUATOR_WASM_BYTES) });
    const cursor = tier0CursorOver(ev, file, extent(ev));
    const ids: string[] = [];
    for (let guard = 0; guard < 1e5; guard++) {
      const batch = cursor.next(8);
      if (batch === null) break;
      ids.push(...batch.map((e) => e.entityId));
    }
    expect(new Set(ids).size, "no entity twice").toBe(ids.length);
  });
});
