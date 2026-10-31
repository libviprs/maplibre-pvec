import { describe, expect, it } from "vitest";
import { TieredCache } from "../../../src/source/cache";
import { EDGE, placement, Rig, TILE } from "../helpers/raster_rig";

// Issue 105 (RM1.3): a tile's bytes through the three tiers. The rig counts what is alive (bitmaps not closed, textures not
// deleted, encoded tiles resident) without asking the cache, so the cache's own totals are checked against an independent one.

const KEY = (k: string): [number, number, number, number] => k.slice(1).split("/").map(Number) as [number, number, number, number];
const mulberry32 = (a: number) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function totalsMatch(r: Rig): void {
  const i = r.independent();
  expect(r.cache.bytes("compressed"), "encoded tier").toBe(i.compressed);
  expect(r.cache.bytes("decoded"), "decoded tier").toBe(i.decoded);
  expect(r.cache.bytes("gpu"), "gpu tier").toBe(i.gpu);
  const gpu = new Set(r.cache.keys("gpu"));
  for (const k of r.cache.keys("decoded")) expect(gpu.has(k), `${k} is a bitmap and a texture at once`).toBe(false);
}

async function settle(r: Rig, rounds = 80): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    r.step();
    await r.tick();
    r.deliver();
    await r.tick();
    if (!r.pending.length && r.stats.at(-1)?.pending === 0 && r.stats.at(-1)?.uploads === 0) return;
  }
}

describe("#105 the tiers of a tile", () => {
  it("a tile is encoded, then a bitmap, then a texture, and the tiers equal the independent total at every step", async () => {
    const r = new Rig([placement(0)]);
    let sawEncoded = 0, sawDecoded = 0;
    for (let i = 0; i < 40; i++) {
      r.step();
      await r.tick();
      sawEncoded = Math.max(sawEncoded, r.cache.bytes("compressed"));
      totalsMatch(r);
      r.deliver(2);
      await r.tick();
      sawDecoded = Math.max(sawDecoded, r.cache.bytes("decoded"));
      totalsMatch(r);
    }
    await settle(r);
    expect(sawEncoded, "the encoded bytes were accounted in the compressed tier").toBeGreaterThan(0);
    expect(sawDecoded, "a bitmap was accounted in the decoded tier until it was uploaded").toBeGreaterThanOrEqual(TILE);
    expect(r.cache.bytes("gpu")).toBeGreaterThan(0);
    expect(r.cache.keys("decoded"), "every bitmap was closed and left the tier after its upload").toEqual([]);
    expect(r.bitmaps.every((b) => b.closed)).toBe(true);
  });

  it("a texture is TILE bytes of RGBA8 whatever the codec, and the encoded bytes stay in the compressed tier while it is up", async () => {
    const r = new Rig([placement(0, { codec: 2, channels: 3 })]);
    await settle(r);
    const gpu = r.cache.keys("gpu");
    expect(gpu.length).toBeGreaterThan(0);
    expect(r.cache.bytes("gpu")).toBe(gpu.length * TILE);
    for (const k of gpu) expect(r.cache.has("compressed", k), `${k} is retained encoded`).toBe(true);
  });
});

describe("#105 eviction terms", () => {
  const put = (c: TieredCache, key: string, raster: number, level: number, visible = false) => c.put("gpu", key, 1000, { raster, level, visible } as never);
  const order = (c: TieredCache) => c.evictionLog.map((e) => e.key);

  it("in the current plan outranks everything, then the level distance from the wanted level, then recency, then the key", () => {
    const c = new TieredCache({ gpu: 8000 });
    c.setWantedLevels(new Map([[0, 2]]));
    put(c, "plan-far", 0, 0, true);
    put(c, "coarse1-old", 0, 1);
    put(c, "coarse1-new", 0, 1);
    put(c, "fine1", 0, 3);
    put(c, "coarse2", 0, 0);
    put(c, "wanted-level-not-in-plan", 0, 2);
    put(c, "tie-b", 0, 3);
    put(c, "tie-a", 0, 3);
    c.get("gpu", "fine1");
    for (let i = 0; i < 7; i++) put(c, `fill${i}`, 0, 2, true);
    // farthest first (level 0 is two below the wanted 2), then the finer unwanted level before the retained coarser one of equal
    // distance, the older of equal terms going first (fine1 was read last, so it outlasts its twins)
    expect(order(c).slice(0, 7)).toEqual(["coarse2", "tie-b", "tie-a", "fine1", "coarse1-old", "coarse1-new", "wanted-level-not-in-plan"]);
    expect(c.has("gpu", "plan-far"), "an entry in the plan is not evicted while anything outside it is resident").toBe(true);
  });

  it("entries without a raster keep the order they had: visibility, refinement, recency, key", () => {
    const c = new TieredCache({ gpu: 3000 });
    c.setWantedLevels(new Map([[0, 2]]));
    c.put("gpu", "b", 1000, {});
    c.put("gpu", "a", 1000, {});
    c.put("gpu", "z", 1000, {});
    c.get("gpu", "b");
    c.put("gpu", "n", 1000, {});
    expect(order(c)).toEqual(["a"]);
  });
});

describe("#105 the retained coarser level", () => {
  it("survives while the finer level is in flight, and goes once the finer level is resident", async () => {
    const r = new Rig([placement(0)]);
    r.step();
    await r.tick();
    r.deliver(Infinity, () => 0, (k) => KEY(k)[1] === 2);
    for (let i = 0; i < 12; i++) {
      r.step();
      await r.tick();
      r.deliver(Infinity, () => 0, (k) => KEY(k)[1] === 2);
    }
    const coarse = r.cache.keys("gpu").filter((k) => KEY(k)[1] === 2);
    expect(coarse.length, "the coarser level is on screen while the fine tiles are held back").toBeGreaterThan(0);
    r.deliver();
    await settle(r);
    expect(r.cache.keys("gpu").filter((k) => KEY(k)[1] === 2), "the coarser level is released once the finer one is resident").toEqual([]);
    totalsMatch(r);
  });
});

describe("#105 the budgets", () => {
  it("a view that would cross gpuBytes draws from a coarser level, stays under the ceiling at every step and evicts nothing but textures", async () => {
    const r = new Rig([placement(0)], { gpuBytes: 6 * TILE });
    for (let i = 0; i < 40; i++) {
      r.step();
      await r.tick();
      r.deliver(3);
      expect(r.cache.bytes("gpu")).toBeLessThanOrEqual(6 * TILE);
    }
    expect(r.stats.at(-1)!.levels.every((l) => l < 3), "drawn coarser than the wanted full resolution").toBe(true);
    expect(r.cache.evictionLog.every((e) => e.tier === "gpu" || e.tier === "compressed" || e.tier === "decoded")).toBe(true);
    totalsMatch(r);
  });

  it("maxDecodedBytes stops the decode queue and resumes it when a bitmap is uploaded", async () => {
    // Calibrate: how many tiles the plan holds at the wanted level, and how many coarser ones sit under them while it loads.
    // The camera sits on a corner shared by four tiles of the wanted level, whose parent is one tile of the coarser level.
    const probe = new Rig([placement(0)]);
    probe.viewport = [300, 300];
    probe.cx = probe.cy = 1280;
    await settle(probe);
    const fine = new Set(probe.requests.filter((k) => KEY(k)[1] === 3)).size;
    const coarse = new Set(probe.requests.filter((k) => KEY(k)[1] === 2)).size;
    expect(fine).toBe(4);
    expect(coarse).toBe(1);
    // The plan fits the cap (LIMIT-16 leaves the level alone), the coarser tiles under it do not fit beside it: the queue must wait.
    const cap = fine + coarse - 1;
    const r = new Rig([placement(0)], { maxDecodedBytes: cap * TILE });
    r.viewport = [300, 300];
    r.cx = r.cy = 1280;
    let waited = false;
    for (let i = 0; i < 80; i++) {
      r.step();
      await r.tick();
      const held = r.pending.length + r.independent().decoded / TILE;
      expect(held, "bitmaps in flight plus bitmaps waiting").toBeLessThanOrEqual(cap);
      waited ||= held === cap && new Set(r.posted).size < fine + coarse;
      r.deliver(1);
      await r.tick();
    }
    expect(waited, "the queue was held at the cap with tiles still to ask for").toBe(true);
    expect(new Set(r.posted.filter((k) => KEY(k)[1] === 3)).size, "and it resumed until the whole plan was asked for").toBe(fine);
  });

  it("a tile that left the plan while its decode was in flight is closed when it arrives, not uploaded", async () => {
    const r = new Rig([placement(0)]);
    r.step();
    await r.tick();
    const stale = r.pending.length;
    expect(stale).toBeGreaterThan(0);
    const before = r.pending.map((p) => p.key);
    r.cx += 100000;
    r.step();
    await r.tick();
    r.deliver(stale, () => 0, (k) => before.includes(k));
    await r.tick();
    r.step();
    expect(r.texturesEver.filter(() => true).length, "nothing from the old view was uploaded").toBe(0);
    expect(r.bitmaps.filter((b) => b.closed).length).toBe(stale);
    expect(r.cache.keys("decoded").filter((k) => before.includes(k))).toEqual([]);
    totalsMatch(r);
  });
});

describe("#105 context loss", () => {
  it("with the encoded bytes retained, a restore rebuilds every texture and makes zero requests", async () => {
    const r = new Rig([placement(0)]);
    await settle(r);
    const requests = r.requests.length;
    const had = r.cache.keys("gpu").length;
    expect(had).toBeGreaterThan(0);
    r.textures.clear();
    r.renderer.onContextLost();
    expect(r.cache.bytes("gpu"), "the textures are gone with the context").toBe(0);
    await settle(r);
    expect(r.requests.length, "zero requests after the restore").toBe(requests);
    expect(r.cache.keys("gpu").length).toBe(had);
    totalsMatch(r);
  });

  it("without the encoded bytes (evicted from the compressed tier) the plan is run again", async () => {
    const r = new Rig([placement(0)], { compressedBytes: 2000 });
    await settle(r);
    const requests = r.requests.length;
    r.textures.clear();
    r.renderer.onContextLost();
    await settle(r);
    expect(r.requests.length).toBeGreaterThan(requests);
    totalsMatch(r);
  });
});

describe("#105 soak", () => {
  it("200,000 seeded operations keep every tier under its ceiling, equal to the independent total, and the viewport resident when still", async () => {
    const rnd = mulberry32(105);
    const r = new Rig([placement(0), placement(1, { pixelToSource: [2, 0, 0, 2, 3000, 0] }), placement(2, { width: 1024, height: 1024, levels: 3, pixelToSource: [0.5, 0, 0, 0.5, 0, 3000] })], {
      gpuBytes: 24 * TILE,
      decodedBytes: 12 * TILE,
      compressedBytes: 30_000,
      maxDecodedBytes: 8 * TILE,
    });
    let ops = 0;
    const check = () => {
      totalsMatch(r);
      expect(r.cache.bytes("gpu")).toBeLessThanOrEqual(r.cache.ceiling("gpu"));
      expect(r.cache.bytes("decoded")).toBeLessThanOrEqual(r.cache.ceiling("decoded"));
      expect(r.cache.bytes("compressed")).toBeLessThanOrEqual(r.cache.ceiling("compressed"));
      expect(r.pending.length + r.independent().decoded / TILE).toBeLessThanOrEqual(8);
    };
    while (ops < 200_000) {
      const x = rnd();
      if (x < 0.3) {
        if (rnd() < 0.15) {
          r.cx = rnd() * 6000;
          r.cy = rnd() * 6000;
          r.scale = [0.25, 0.5, 1, 2][Math.floor(rnd() * 4)]!;
        } else {
          r.cx += (rnd() - 0.5) * 300;
          r.cy += (rnd() - 0.5) * 300;
        }
        r.step();
      } else if (x < 0.75) {
        r.deliver(1, (n) => Math.floor(rnd() * n));
        await r.tick(3);
      } else if (x < 0.999) {
        await r.tick(2);
      } else {
        r.textures.clear();
        r.renderer.onContextLost();
      }
      ops++;
      check();
      if (ops % 20_000 === 0) {
        await settle(r);
        const s = r.stats.at(-1)!;
        expect(s.pending, "the still viewport is resident").toBe(0);
        check();
      }
    }
    expect(ops).toBe(200_000);
  }, 300_000);
});
