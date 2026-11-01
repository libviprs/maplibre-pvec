import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Tier0Decoder, type EntityDraw } from "../../src/decode/tier0";
import { buildQueryEngine, exactQueryOver, type PickView } from "../../src/layer/query";
import { fullViewPx, tier0CursorOver } from "../../src/layer/tier0-cursor";
import { nearestEntity, pickPoint, queryRegion } from "../../src/pick/index";
import { loadEvaluator } from "../../src/wasm/loader";
import { EVALUATOR_WASM_BYTES } from "./helpers/probe";

// Issue 150: the query engine of a real layer. The distances come from the module's exact entity_distance, and the references here
// are the maths of pvec-gold-fixtures' authoring parameters (a segment, a circle, a cubic Bezier), none of it from the add-on.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bytes = (id: string): Uint8Array => new Uint8Array(readFileSync(join(root, "tests/fixtures/pvec", `${id}.pvec`)));
// the extent the fixtures sit in, as the manifest's source bounds are for a layer: a pixel of the Tier 0 walk is 1/1920 of it
const WINDOW: [number, number, number, number] = [-2, -6, 6, 6];
const SLACK = 1e-9;
const near = (a: number, b: number, slack = SLACK): boolean => Math.abs(a - b) <= slack;

// one CSS pixel is 0.01 source units, and lng/lat are the source coordinates themselves
const UPX = 0.01;
const view: PickView = { lngLatToSource: (l) => ({ x: l.lng, y: l.lat }), sourceUnitsPerCssPx: () => UPX };

async function engineOf(id: string) {
  const evaluator = await loadEvaluator({ wasmModule: await WebAssembly.compile(EVALUATOR_WASM_BYTES) });
  const cursor = tier0CursorOver(evaluator, bytes(id), WINDOW);
  const draws: EntityDraw[] = new Tier0Decoder().decodeAll(cursor);
  cursor.close();
  const exact = exactQueryOver(evaluator, bytes(id))!;
  expect(exact, "the pinned module exports the distance calls").not.toBeNull();
  const generations = new Map<string, number>();
  const hidden = new Set<string>();
  const engine = buildQueryEngine({
    exact,
    draws,
    tier0Px: fullViewPx(WINDOW),
    view: () => view,
    generation: (entityId) => generations.get(entityId) ?? 0,
    halfWidthPx: () => 0.5,
    visible: (entityId) => !hidden.has(entityId),
  });
  return { engine, exact, draws, generations, hidden };
}

const toSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};

describe("#150 the query engine over the module's exact distance", () => {
  it("a line: the pick returns the entity at the exact distance in CSS pixels", async () => {
    const { engine, exact } = await engineOf("line-001");
    // 0.03 source units off the segment (0.5, 0.25) to (3.75, 2.5), across its middle
    const mid = [(0.5 + 3.75) / 2, (0.25 + 2.5) / 2];
    const n = Math.hypot(2.5 - 0.25, -(3.75 - 0.5));
    const at = { lng: mid[0]! + (0.03 * (2.5 - 0.25)) / n, lat: mid[1]! - (0.03 * (3.75 - 0.5)) / n };
    const r = pickPoint(engine, at, { radiusPx: 4 });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.entityId).toBe("0");
    const want = toSegment(at.lng, at.lat, 0.5, 0.25, 3.75, 2.5) / UPX;
    expect(near(r.hits[0]!.distancePx, want, 1e-6), `${r.hits[0]!.distancePx} vs ${want}`).toBe(true);
    expect(near(want, 3, 1e-9)).toBe(true);
    expect(r.complete).toBe(true);
    exact.close();
  });

  it("an arc (a circle): inside and outside the curve, and far away returns nothing", async () => {
    const { engine, exact } = await engineOf("circle-001");
    const c = { x: 1.5, y: -2.25, r: 2.75 };
    const outside = pickPoint(engine, { lng: c.x + c.r + 0.02, lat: c.y }, { radiusPx: 4 });
    expect(outside.hits).toHaveLength(1);
    expect(near(outside.hits[0]!.distancePx, 2, 1e-6)).toBe(true);
    const inside = pickPoint(engine, { lng: c.x + (c.r - 0.03) * Math.cos(1), lat: c.y + (c.r - 0.03) * Math.sin(1) }, { radiusPx: 4 });
    expect(near(inside.hits[0]!.distancePx, 3, 1e-6)).toBe(true);
    // the centre of the circle is 2.75 units, 275 px, from the curve
    expect(pickPoint(engine, { lng: c.x, lat: c.y }, { radiusPx: 4 }).hits).toEqual([]);
    exact.close();
  });

  it("a spline (a cubic Bezier): the distance equals a dense sampling of the curve", async () => {
    const { engine, exact } = await engineOf("bezier-d3-001");
    const P = [[0, 0], [1, 2.5], [3, 2.5], [4, 0]] as const;
    const bez = (t: number): [number, number] => {
      const u = 1 - t;
      return [0, 1].map((k) => u * u * u * P[0]![k]! + 3 * u * u * t * P[1]![k]! + 3 * u * t * t * P[2]![k]! + t * t * t * P[3]![k]!) as [number, number];
    };
    const at = { lng: 2, lat: 2.2 };
    let best = Infinity;
    for (let i = 0; i <= 200000; i++) {
      const [x, y] = bez(i / 200000);
      best = Math.min(best, Math.hypot(x - at.lng, y - at.lat));
    }
    const r = pickPoint(engine, at, { radiusPx: 60 });
    expect(r.hits).toHaveLength(1);
    expect(near(r.hits[0]!.distancePx * UPX, best, 1e-6), `${r.hits[0]!.distancePx * UPX} vs ${best}`).toBe(true);
    exact.close();
  });

  it("nearestEntity finds the nearer of two, and a hidden entity is not returned by the layer's filter", async () => {
    const { engine, exact, hidden } = await engineOf("layer-state-001");
    const segs = [[0, 0, 4, 1], [0, 2, 3, 3.5], [0, 5, 5.5, 4]] as const;
    const at = { lng: 2, lat: 1.9 };
    const d = segs.map(([ax, ay, bx, by]) => toSegment(at.lng, at.lat, ax, ay, bx, by));
    const want = String(d.indexOf(Math.min(...d)));
    const n = nearestEntity(engine, at, { maxRadiusPx: 500 });
    expect(n.hit?.entityId).toBe(want);
    expect(near(n.hit!.distancePx * UPX, Math.min(...d), 1e-6)).toBe(true);
    hidden.add(want);
    expect(engine.quarantined(want)).toBe(true);
    exact.close();
  });

  it("queryRegion is set exact: a box that holds the corner of the bounds but not the segment returns nothing", async () => {
    const { engine, exact } = await engineOf("line-001");
    // the segment (0.5, 0.25) to (3.75, 2.5): the box around (3.5, 0.5) is inside its bounds and 1.4 units from it
    expect(queryRegion(engine, { minX: 3.4, minY: 0.4, maxX: 3.6, maxY: 0.6 }).hits).toEqual([]);
    const across = queryRegion(engine, { minX: 2.0, minY: 1.0, maxX: 2.4, maxY: 1.6 });
    expect(across.hits.map((h) => h.entityId)).toEqual(["0"]);
    expect(across.complete).toBe(true);
    exact.close();
  });

  it("generations come from the refinement and boundsOf from the Tier 0 draw", async () => {
    const { engine, exact, generations } = await engineOf("line-001");
    generations.set("0", 3);
    expect(engine.generation("0")).toBe(3);
    const b = engine.boundsOf("0");
    expect(near(b.minX, 0.5) && near(b.maxX, 3.75) && near(b.minY, 0.25) && near(b.maxY, 2.5)).toBe(true);
    expect(engine.tier0Complete()).toBe(true);
    exact.close();
  });
});
