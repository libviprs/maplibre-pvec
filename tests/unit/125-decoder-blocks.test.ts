import { describe, expect, it } from "vitest";
import { Tier0Decoder, type BlockCursor, type RawEntity } from "../../src/decode/tier0";

const e = (id: number): RawEntity => ({ entityId: `e${id}`, kind: "preview", geometry: { type: "polyline", points: [0, 0, 1, 1] }, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, declaredErrorPx: 1 });

/** A cursor of blocks of the given sizes, `next` returning at most one block's worth at a time and never across a block. */
function blocks(sizes: number[], cost = 0, clock?: { t: number }): BlockCursor & { ended: number } {
  let b = 0, left = sizes[0] ?? 0, id = 0, ended = false;
  const c = {
    ended: 0,
    next(max: number): RawEntity[] | null {
      if (clock) clock.t += cost;
      ended = false;
      if (b >= sizes.length) return null;
      const n = Math.min(max, left);
      const out = Array.from({ length: n }, () => e(id++));
      left -= n;
      if (left === 0) (ended = true, c.ended++, b++, (left = sizes[b] ?? 0));
      return out;
    },
    endsBlock: () => ended,
  };
  return c;
}

describe("#125 the decoder counts a block, not a file", () => {
  it("accepts many blocks that are each under maxEntitiesPerBlock though together they are far over it", () => {
    const d = new Tier0Decoder({ maxEntitiesPerBlock: 100, maxSliceMs: 8, now: () => 0 });
    const draws = d.decodeAll(blocks(Array.from({ length: 50 }, () => 90)));
    expect(draws.length).toBe(4500);
  });

  it("still refuses one block over the limit, whatever came before it", () => {
    const d = new Tier0Decoder({ maxEntitiesPerBlock: 100, maxSliceMs: 8, now: () => 0 });
    expect(() => d.decodeAll(blocks([90, 90, 101]))).toThrow(/maxEntitiesPerBlock/);
  });

  it("a cursor that does not say where its blocks end is one block, as before", () => {
    const d = new Tier0Decoder({ maxEntitiesPerBlock: 100, maxSliceMs: 8, now: () => 0 });
    const plain = blocks([90, 90]);
    delete (plain as { endsBlock?: unknown }).endsBlock;
    expect(() => d.decodeAll(plain)).toThrow(/maxEntitiesPerBlock/);
  });
});

describe("#125 a slice does not start a call that could not end inside the budget", () => {
  it("with calls of 3 ms, no slice is longer than 8 ms", () => {
    const clock = { t: 0 };
    const d = new Tier0Decoder({ maxEntitiesPerBlock: 1e6, maxSliceMs: 8, now: () => clock.t });
    const cursor = blocks([400], 3, clock);
    const lengths: number[] = [];
    for (;;) {
      const start = clock.t;
      const s = d.decodeSlice(cursor);
      if (!s) break;
      lengths.push(clock.t - start);
    }
    expect(lengths.length).toBeGreaterThan(5);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(8);
  });
});
