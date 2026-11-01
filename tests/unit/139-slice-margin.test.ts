import { describe, expect, it } from "vitest";
import { Tier0Decoder, type BlockCursor, type RawEntity } from "../../src/decode/tier0";

const entity = (id: number): RawEntity => ({ entityId: `e${id}`, kind: "preview", geometry: { type: "polyline", points: [0, 0, 1, 1] }, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, declaredErrorPx: 1 });

/** A cursor on a clock the test owns: call `i` costs `costs[i]` ms (1 ms after the list), and it ends after `calls` calls. */
function timed(costs: number[], calls: number, clock: { t: number }): BlockCursor {
  let i = 0;
  return {
    next(): RawEntity[] | null {
      if (i >= calls) return null;
      clock.t += costs[i] ?? 1;
      return [entity(i++)];
    },
  };
}

describe("#139 a slice keeps room for a call a little longer than the longest it has seen", () => {
  it("a call 20 percent over the longest before it still ends the slice inside the bound", () => {
    const clock = { t: 0 };
    const d = new Tier0Decoder({ maxEntitiesPerBlock: 100, maxSliceMs: 8, now: () => clock.t });
    const first = d.decodeSlice(timed([3, 1.5, 3.6], 50, clock));
    expect(first, "the first slice").not.toBeNull();
    expect(clock.t, "the clock when the first slice returned").toBeLessThanOrEqual(8);
  });

  it("the walk still ends, in slices that each do some work", () => {
    const clock = { t: 0 };
    const d = new Tier0Decoder({ maxEntitiesPerBlock: 100, maxSliceMs: 8, now: () => clock.t });
    const cursor = timed([3, 1.5, 3.6], 30, clock);
    let drawn = 0, slices = 0;
    for (let guard = 0; guard < 1e4; guard++) {
      const s = d.decodeSlice(cursor);
      if (!s) break;
      expect(s.draws.length).toBeGreaterThan(0);
      drawn += s.draws.length;
      slices++;
    }
    expect(drawn).toBe(30);
    expect(slices).toBeGreaterThan(1);
  });
});
