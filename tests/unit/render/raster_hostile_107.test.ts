import { describe, expect, it } from "vitest";
import { placement, Rig, TILE } from "../helpers/raster_rig";

// Issue 107 (RM1.5): what the layer does with a tile it cannot show. A refusal by the module (a sniffer rule) and a decode that
// fails in the browser are different things: the first names a rule and drops the raster, the second is a missing tile.

async function run(r: Rig, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    r.step();
    await r.tick();
    r.deliver();
    await r.tick();
  }
}

describe("#107 a tile the module refuses", () => {
  it("is one report with its rule, no error, and the raster's other tiles are never asked for again", async () => {
    const r = new Rig([placement(0), placement(1)]);
    r.refuse.set(1, "RASTER-03");
    await run(r, 30);
    expect(r.refused).toEqual([{ rasterId: 1, rule: "RASTER-03", message: expect.stringContaining("RASTER-03") }]);
    expect(r.errors, "a refusal is not an error").toEqual([]);
    const asked = r.requests.filter((k) => k.startsWith("r1/")).length;
    await run(r, 30);
    expect(r.requests.filter((k) => k.startsWith("r1/")).length, "the dropped raster is not asked for again").toBe(asked);
    expect(r.requests.some((k) => k.startsWith("r0/")), "the other raster draws").toBe(true);
    expect(r.cache.keys("gpu").some((k) => k.startsWith("r0/"))).toBe(true);
    expect(r.cache.keys("gpu").some((k) => k.startsWith("r1/"))).toBe(false);
  });

  it("keeps every rule it is given: LIMIT-15 and RASTER-04 are reported as they come", async () => {
    const r = new Rig([placement(0), placement(1), placement(2)]);
    r.refuse.set(0, "LIMIT-15");
    r.refuse.set(1, "RASTER-04");
    r.refuse.set(2, "RASTER-03");
    await run(r, 20);
    expect(r.refused.map((e) => [e.rasterId, e.rule]).sort()).toEqual([[0, "LIMIT-15"], [1, "RASTER-04"], [2, "RASTER-03"]]);
  });
});

describe("#107 a valid header over a corrupt body", () => {
  it("is a missing tile: retried a bounded number of times, counted, never in a loop, and the raster is not dropped", async () => {
    const r = new Rig([placement(0)]);
    r.failDecodes = true;
    await run(r, 400);
    const s = r.stats.at(-1)!;
    const tiles = new Set(r.requests).size;
    expect(tiles).toBeGreaterThan(0);
    expect(s.failedTiles, "every tile ends up counted as missing").toBe(tiles);
    expect(s.decodeFailures, "at most 3 attempts a tile").toBeLessThanOrEqual(3 * tiles);
    expect(s.decodeFailures).toBeGreaterThan(tiles);
    const posted = r.posted.length;
    await run(r, 200);
    expect(r.posted.length, "no more attempts once the bound is reached").toBe(posted);
    expect(r.refused, "a corrupt body is not a refusal").toEqual([]);
    expect(r.requests.length, "the encoded bytes are kept: a retry makes no request").toBe(tiles);
    expect(r.cache.bytes("gpu")).toBe(0);
    expect(r.cache.bytes("decoded")).toBe(0);
  });

  it("recovers when the tile decodes on a later attempt", async () => {
    const r = new Rig([placement(0)]);
    r.failDecodes = true;
    await run(r, 60);
    r.failDecodes = false;
    await run(r, 400);
    expect(r.cache.bytes("gpu")).toBeGreaterThan(0);
  });
});

describe("#107 a placement at a tiny scale", () => {
  it("is drawn at the level LIMIT-16 allows, and the host never holds more than maxDecodedBytes", async () => {
    const cap = 6 * TILE;
    const r = new Rig([placement(0, { width: 8192, height: 8192, levels: 6 })], { maxDecodedBytes: cap });
    r.scale = 1;
    let peak = 0;
    for (let i = 0; i < 80; i++) {
      r.step();
      await r.tick();
      peak = Math.max(peak, r.independent().decoded + r.pending.length * TILE);
      r.deliver(2);
      await r.tick();
    }
    expect(peak).toBeLessThanOrEqual(cap);
    expect(Math.max(...r.stats.at(-1)!.levels), "the full-resolution level (5) would need more than the cap").toBeLessThan(5);
    expect(r.stats.at(-1)!.pending, "and what is asked for gets drawn").toBe(0);
  });
});
