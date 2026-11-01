import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tier0CursorOver } from "../../src/layer/tier0-cursor";
import { loadEvaluator, type Evaluator } from "../../src/wasm/loader";
import { bindPacked } from "../../src/wasm/packed";
import { EVALUATOR_WASM_BYTES } from "./helpers/probe";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const file = new Uint8Array(readFileSync(join(root, "tests/fixtures/pvec-leaves", "leaf100.pvec")));

afterEach(() => vi.restoreAllMocks());

/**
 * The module with a clock the test owns: every call of `tessellate_batch` advances it by `costMs`, and the count asked of
 * each `query_leaf` is recorded.
 */
async function timed(costMs: number): Promise<{ ev: Evaluator; asked: number[] }> {
  const ev = await loadEvaluator({ wasmModule: await WebAssembly.compile(EVALUATOR_WASM_BYTES) });
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const asked: number[] = [];
  const exports = Object.fromEntries(
    Object.entries(ev.instance.exports as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === "function"
        ? (...a: unknown[]) => {
            if (k === "query_leaf") asked.push(a[3] as number);
            if (k === "tessellate_batch") clock += costMs;
            return (v as (...x: unknown[]) => unknown)(...a);
          }
        : v,
    ]),
  );
  return { ev: { ...ev, instance: { exports } as unknown as WebAssembly.Instance }, asked };
}

function extent(ev: Evaluator): [number, number, number, number] {
  const rt = bindPacked(ev);
  const f = rt.open(file);
  const b = [0, 1, 2, 3].map((n) => rt.directoryBound(f, n)) as [number, number, number, number];
  rt.release(f);
  return b;
}

function drain(ev: Evaluator): string[] {
  const cursor = tier0CursorOver(ev, file, extent(ev));
  const ids: string[] = [];
  for (let guard = 0; guard < 1e5; guard++) {
    const batch = cursor.next(8);
    if (batch === null) return ids;
    ids.push(...batch.map((e) => e.entityId));
  }
  throw new Error("the cursor never ended");
}

describe("#136 a step holds as many entities as a slice can afford", () => {
  it("a cheap walk starts with a small page and asks for more as it goes", async () => {
    const { ev, asked } = await timed(0);
    drain(ev);
    const pages = asked.filter((n) => n > 0);
    expect(pages.length, "query_leaf calls").toBeGreaterThan(1);
    expect(pages[0], "the first page").toBeLessThanOrEqual(16);
    expect(pages[1]!, "the second page").toBeGreaterThan(pages[0]!);
  });

  it("a page that costs more than a slice can hold is followed by a smaller one, down to one entity", async () => {
    const { ev, asked } = await timed(5);
    drain(ev);
    expect(asked.length, "query_leaf calls").toBeGreaterThan(3);
    for (let i = 1; i < asked.length; i++) {
      const before = asked[i - 1]!;
      expect(asked[i]!, `page ${i} after an expensive page`).toBeLessThan(Math.max(before, 2));
    }
    expect(Math.min(...asked)).toBe(1);
  });

  it("the entities answered are the same whatever the pages were", async () => {
    const cheap = drain((await timed(0)).ev);
    vi.restoreAllMocks();
    const dear = drain((await timed(5)).ev);
    expect(dear.length).toBeGreaterThan(0);
    expect([...dear].sort()).toEqual([...cheap].sort());
    expect(new Set(dear).size, "no entity twice").toBe(dear.length);
  });
});
