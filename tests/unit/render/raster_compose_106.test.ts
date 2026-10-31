import { describe, expect, it } from "vitest";
import { tileQuad } from "../../../src/render/raster/geometry";
import { placement, Rig } from "../helpers/raster_rig";

// Issue 106 (RM1.4): where the quads sit. The map-level claims (draw order, stencil, blending against MapLibre's own layers,
// alignment, pitch) are in tests/e2e/rendering/106-raster-compose.spec.ts. These are the parts that need no map.

async function settle(r: Rig, rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    r.step();
    await r.tick();
    r.deliver();
    await r.tick();
    if (!r.pending.length && r.stats.at(-1)?.pending === 0 && r.stats.at(-1)?.uploads === 0) return;
  }
}

describe("#106 texture V", () => {
  it("comes from the pixel row for d < 0 and for d > 0: the top row of the image is V = 0 whichever way the placement flips", () => {
    for (const d of [-1, 1]) {
      const p = placement(0, { pixelToSource: [1, 0, 0, d, 0, d < 0 ? 2048 : 0] });
      const q = tileQuad(p, 3, 1, 2)!;
      expect(q.uv, `d = ${d}`).toEqual([0, 0, 1, 1]);
      expect(q.px, `d = ${d}`).toEqual([256, 512, 512, 768]);
    }
  });
});

describe("#106 a hot georeference", () => {
  it("rebuilds the quad positions and nothing else: same textures, zero decodes, zero requests, and the transform epoch is what guards it", async () => {
    const r = new Rig([placement(0)]);
    await settle(r);
    const textures = r.texturesEver.length, requests = r.requests.length, posted = r.posted.length, uploads = r.vertexUploads.length;
    const before = r.vertexUploads.at(-1)!;
    expect(before.length).toBeGreaterThan(0);

    // Without the epoch bump the cached positions stand: the epoch is the guard, exactly as it is for stroke tessellations.
    r.world = [0.5, 0.25];
    r.step();
    expect(r.vertexUploads.length, "no rebuild without a new epoch").toBe(uploads);

    r.renderer.setTransformEpoch(1);
    await settle(r);
    expect(r.vertexUploads.length, "positions were sent again").toBeGreaterThan(uploads);
    const after = r.vertexUploads.at(-1)!;
    expect(after.length).toBe(before.length);
    expect(after[0]! - before[0]!, "every corner moved by the new world offset (hi part, x)").toBeCloseTo(0.5, 5);
    expect(after[1]! - before[1]!, "(hi part, y)").toBeCloseTo(0.25, 5);
    expect(r.texturesEver.length, "texture ids unchanged").toBe(textures);
    expect(r.requests.length, "zero requests").toBe(requests);
    expect(r.posted.length, "zero decodes").toBe(posted);
  });

  it("a decode in flight when the georeference changes still lands: a decode does not depend on the transform", async () => {
    const r = new Rig([placement(0)]);
    r.step();
    await r.tick();
    const flying = r.pending.length;
    expect(flying).toBeGreaterThan(0);
    r.renderer.setTransformEpoch(1);
    r.world = [0.1, 0.1];
    await settle(r);
    expect(r.bitmaps.filter((b) => b.closed).length, "every bitmap was uploaded and closed, none refused").toBe(r.bitmaps.length);
    expect(r.texturesEver.length).toBeGreaterThanOrEqual(flying);
  });

  it("a scale change re-picks the level", async () => {
    const r = new Rig([placement(0)]);
    await settle(r);
    const fine = r.stats.at(-1)!.levels;
    r.scale = 0.25;
    r.renderer.setTransformEpoch(1);
    await settle(r);
    const coarse = r.stats.at(-1)!.levels;
    expect(Math.max(...coarse)).toBeLessThan(Math.max(...fine));
  });
});
