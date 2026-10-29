import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPVecLayer, PVecLayerError } from "../../../src/index";
import { controlOf, type QueryEngine } from "../../../src/layer/internal";
import { countingGl, fakeMap, rig, type Rig } from "./helpers";

let r: Rig;
beforeEach(async () => (r = await rig()));
afterEach(async () => r.stop());

/** Horizontal lines y = 10*i, 4 px half width, 1 source unit per device px, expected ids from a table. */
const EXPECTED = ["wall-1", "wall-2", "door-3"];
function engine(over: Partial<QueryEngine> = {}): QueryEngine & { refine(id: string): void } {
  const gen = new Map<string, number>();
  const e: QueryEngine & { refine(id: string): void } = {
    pipeline: {
      lngLatToSource: (l) => ({ x: l.lng, y: l.lat }),
      sourceUnitsPerDevicePx: () => 1,
    },
    index: {
      query: (b) =>
        EXPECTED.map((id, i) => ({ id, y: 10 * i }))
          .filter((c) => c.y >= b.minY && c.y <= b.maxY)
          .map((c) => ({ entityId: c.id, entityType: c.id.split("-")[0]! })),
      isLoaded: () => true,
    },
    evaluator: {
      distance: (id, p) => Math.abs(p.y - 10 * EXPECTED.indexOf(id)),
      intersects: (id, region) => {
        const y = 10 * EXPECTED.indexOf(id);
        const b = region as { minY: number; maxY: number };
        return y >= b.minY && y <= b.maxY;
      },
    },
    generation: (id) => gen.get(id) ?? 0,
    maxCandidateRadiusPx: 64,
    boundsOf: (id) => ({ minX: 0, maxX: 100, minY: 10 * EXPECTED.indexOf(id), maxY: 10 * EXPECTED.indexOf(id) }),
    halfWidthPx: () => 4,
    tier0Complete: () => true,
    quarantined: () => false,
    refine: (id) => gen.set(id, (gen.get(id) ?? 0) + 1),
    ...over,
  };
  return e;
}
const at = (y: number): { lng: number; lat: number } => ({ lng: 50, lat: y });

async function ready(over: Partial<QueryEngine> = {}) {
  const layer = createPVecLayer({ id: "a", source: { url: r.url } });
  const { gl } = countingGl();
  layer.onAdd(fakeMap, gl);
  await layer.whenReady();
  const e = engine(over);
  controlOf(layer).attachQuery(e);
  return { layer, gl, e };
}

describe("#26 M7.5 query and picking", () => {
  it("returns the stable ids of the known-truth table, and a perturbed table turns red", async () => {
    const { layer } = await ready();
    const all = layer.queryRegion({ minX: 0, minY: -100, maxX: 100, maxY: 100 });
    expect(all.map((h) => h.entityId).sort()).toEqual([...EXPECTED].sort());
    expect(all.map((h) => h.entityId).sort()).not.toEqual(["wall-1", "wall-2", "door-4"].sort());
    expect(all[0]).toMatchObject({ complete: true, entityType: expect.any(String), bounds: expect.any(Object), generation: 0 });
  });

  it("keeps entityId across refinement, only generation changes", async () => {
    const { layer, e } = await ready();
    const a = layer.pickPoint(at(10), {});
    e.refine("wall-2");
    const b = layer.pickPoint(at(10), {});
    expect(a.map((h) => h.entityId)).toEqual(["wall-2"]);
    expect(b.map((h) => h.entityId)).toEqual(["wall-2"]);
    expect([a[0]!.generation, b[0]!.generation]).toEqual([0, 1]);
  });

  it("hits at w + tolerancePx and misses one pixel further, at three zoom levels", async () => {
    for (const [upx, w] of [[1, 4], [0.25, 4], [16, 4]] as const) {
      const pos = (i: number): number => 1000 * upx * i;
      const { layer } = await ready({
        pipeline: { lngLatToSource: (l) => ({ x: l.lng, y: l.lat }), sourceUnitsPerDevicePx: () => upx },
        evaluator: { distance: (id, p) => Math.abs(p.y - pos(EXPECTED.indexOf(id))), intersects: () => true },
        index: {
          query: (b) => EXPECTED.filter((_, i) => pos(i) >= b.minY && pos(i) <= b.maxY).map((id) => ({ entityId: id, entityType: "wall" })),
          isLoaded: () => true,
        },
        halfWidthPx: () => w,
      });
      const tol = 3;
      const y0 = pos(1);
      expect(layer.pickPoint(at(y0 + (w + tol) * upx), { tolerancePx: tol }).map((h) => h.entityId)).toEqual(["wall-2"]);
      expect(layer.pickPoint(at(y0 + (w + tol + 1) * upx), { tolerancePx: tol })).toEqual([]);
    }
  });

  it("nearestEntity returns the closest within the radius, else undefined", async () => {
    const { layer } = await ready();
    expect(layer.nearestEntity(at(12), 8)?.entityId).toBe("wall-2");
    expect(layer.nearestEntity(at(500), 8)).toBeUndefined();
  });

  it("queryRegion lists every non-quarantined id exactly once, even if the index repeats a candidate", async () => {
    const dup = engine();
    const { layer } = await ready({
      index: { query: (b) => [...dup.index.query(b), ...dup.index.query(b)], isLoaded: () => true },
      quarantined: (id) => id === "door-3",
    });
    const ids = layer.queryRegion({ minX: 0, minY: -100, maxX: 100, maxY: 100 }).map((h) => h.entityId);
    expect(ids.sort()).toEqual(["wall-1", "wall-2"]);
  });

  it("before Tier 0 completes results say complete false", async () => {
    const { layer } = await ready({ tier0Complete: () => false });
    expect(layer.pickPoint(at(10), {})[0]!.complete).toBe(false);
  });

  it("follows a georeference update: the same id at the updated position", async () => {
    let dy = 0;
    const { layer } = await ready({
      pipeline: { lngLatToSource: (l) => ({ x: l.lng, y: l.lat - dy }), sourceUnitsPerDevicePx: () => 1 },
    });
    expect(layer.pickPoint(at(10), {}).map((h) => h.entityId)).toEqual(["wall-2"]);
    dy = 50;
    expect(layer.pickPoint(at(60), {}).map((h) => h.entityId)).toEqual(["wall-2"]);
    expect(layer.pickPoint(at(10), {})).toEqual([]);
  });

  it("resolveProvenance is undefined without capability and hook, never a placeholder", async () => {
    const { layer } = await ready();
    expect(layer.resolveProvenance("wall-1")).toBeUndefined();
  });

  it("queries on a removed layer throw PVecLayerError disposed", async () => {
    const { layer, gl } = await ready();
    layer.onRemove(fakeMap, gl);
    for (const f of [() => layer.pickPoint(at(0), {}), () => layer.queryRegion({ minX: 0, minY: 0, maxX: 1, maxY: 1 }), () => layer.nearestEntity(at(0), 4), () => layer.resolveProvenance("x")]) {
      expect(f).toThrow(PVecLayerError);
      expect(f).toThrow(expect.objectContaining({ code: "disposed" }));
    }
  });
});
