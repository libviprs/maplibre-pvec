import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlockCursor, EntityDraw, RawEntity } from "../../../src/decode/tier0";
import type { RefinementEvent } from "../../../src/diagnostics/events";
import { createPVecLayer } from "../../../src/index";
import { configureEngine } from "../../../src/layer/internal";
import { TierRefiner, type RefineView, type RefinementSource } from "../../../src/layer/refinement";
import { countingGl, fakeMap, rig, type Rig } from "../api/helpers";

// Issue 148: the layer drives Tier 1 refinement and emits tier0complete. The orchestrator is tested with stand-ins for the view and for
// the module (a curve costs more points at a finer chord, a line is always its two end points); the layer is tested for the event.

const TIER0_PX = 0.01; // source units of one pixel of the full view the Tier 0 errors are declared in
const arc = (id: string, chord: number): RawEntity => {
  const n = 3 + Math.min(500, Math.ceil(Math.sqrt(1 / Math.max(chord, 1e-9))));
  const points: number[] = [];
  for (let i = 0; i < n; i++) points.push(i / n * 10, Math.sin(i / n * Math.PI) * 5);
  return { entityId: id, kind: "preview", geometry: { type: "polyline", points }, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 5 }, declaredErrorPx: 1 };
};
const line = (id: string): RawEntity => ({ entityId: id, kind: "preview", geometry: { type: "polyline", points: [0, 0, 10, 0] }, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 0 }, declaredErrorPx: 1 });
const far = (id: string): RawEntity => ({ ...arc(id, 1), bounds: { minX: 1000, minY: 1000, maxX: 1010, maxY: 1005 } });
const drawOf = (e: RawEntity): EntityDraw => ({ kind: "preview", entityId: e.entityId, generation: 0, geometry: e.geometry, bounds: e.bounds, declaredErrorPx: 1, conformance: "display-fidelity" });

function world() {
  const asked: { window: readonly number[]; chord: number }[] = [];
  const source: RefinementSource = {
    cursorFor(window, chord) {
      asked.push({ window, chord });
      const all = [arc("1", chord), line("2"), far("3")].filter((e) => e.bounds.maxX >= window[0] && e.bounds.minX <= window[2] && e.bounds.maxY >= window[1] && e.bounds.minY <= window[3]);
      let done = false;
      const cursor: BlockCursor & { close(): void } = { next: () => (done ? null : ((done = true), all)), close: () => undefined };
      return cursor;
    },
  };
  let view: RefineView | undefined = { window: [-1, -1, 11, 6], pxPerSource: 100 };
  const events: RefinementEvent[] = [];
  const sets: EntityDraw[][] = [];
  const refiner = new TierRefiner({
    source,
    view: () => view,
    tier0Px: TIER0_PX,
    idleMs: 0,
    setDraws: (d) => void sets.push([...d]),
    report: (e) => void events.push(e),
  });
  const draws = [drawOf(arc("1", TIER0_PX)), drawOf(line("2")), drawOf(far("3"))];
  return { refiner, events, sets, asked, draws, zoomTo: (px: number, window?: [number, number, number, number]) => (view = { window: window ?? [-1, -1, 11, 6], pxPerSource: px }), noView: () => (view = undefined) };
}

describe("#148 refinement after the camera settles", () => {
  it("reports nothing while the displayed error is within the refine threshold", async () => {
    const w = world();
    w.refiner.start(w.draws);
    await w.refiner.whenIdle();
    expect(w.events).toEqual([]);
    expect(w.asked).toEqual([]);
    expect(w.sets).toEqual([]);
  });

  it("a zoom-in on a curve reports one refinement, generation 1, with the error before and after in device pixels", async () => {
    const w = world();
    w.refiner.start(w.draws);
    w.zoomTo(800);
    w.refiner.settle();
    await w.refiner.whenIdle();
    expect(w.events).toHaveLength(1);
    const e = w.events[0]!;
    expect(e.entityId).toBe("1");
    expect(e.generation).toBe(1);
    expect(e.priorErrorPx).toBe(TIER0_PX * 800);
    expect(e.nextErrorPx).toBe((0.5 / 800) * 800);
    // the cursor was asked for the view's window at 0.5 device px
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0]!.chord).toBe(0.5 / 800);
    // the layer is handed the whole set again with the curve replaced and the other two draws kept
    expect(w.sets).toHaveLength(1);
    expect(w.sets[0]!.map((d) => d.entityId).sort()).toEqual(["1", "2", "3"]);
    const replaced = w.sets[0]!.find((d) => d.entityId === "1")!;
    expect(replaced.geometry).toEqual(arc("1", 0.5 / 800).geometry);
  });

  it("an exact entity (a straight line) is never reported, and an entity outside the view is not asked for", async () => {
    const w = world();
    w.refiner.start(w.draws);
    w.zoomTo(800);
    w.refiner.settle();
    await w.refiner.whenIdle();
    expect(w.events.map((e) => e.entityId)).toEqual(["1"]);
    expect(w.sets[0]!.find((d) => d.entityId === "3")!.geometry).toEqual(w.draws[2]!.geometry);
  });

  it("generations only go up across zoom-ins, and a zoom-out reports nothing", async () => {
    const w = world();
    w.refiner.start(w.draws);
    w.zoomTo(800);
    w.refiner.settle();
    await w.refiner.whenIdle();
    w.zoomTo(6400);
    w.refiner.settle();
    await w.refiner.whenIdle();
    w.zoomTo(100);
    w.refiner.settle();
    await w.refiner.whenIdle();
    expect(w.events.map((e) => [e.entityId, e.generation])).toEqual([["1", 1], ["1", 2]]);
    expect(w.events[1]!.priorErrorPx).toBe((0.5 / 800) * 6400);
  });

  it("asks nothing twice for a view it has already refined", async () => {
    const w = world();
    w.refiner.start(w.draws);
    w.zoomTo(800);
    w.refiner.settle();
    await w.refiner.whenIdle();
    w.refiner.settle();
    await w.refiner.whenIdle();
    expect(w.asked).toHaveLength(1);
    expect(w.events).toHaveLength(1);
  });

  it("cancel drops a run in flight: no event and no draws after it", async () => {
    const w = world();
    w.refiner.start(w.draws);
    w.zoomTo(800);
    w.refiner.settle();
    w.refiner.cancel();
    await w.refiner.whenIdle();
    expect(w.events).toEqual([]);
    expect(w.sets).toEqual([]);
  });

  it("a camera move during a run discards that run's result, and the next settle refines for the new view", async () => {
    const w = world();
    w.refiner.start(w.draws);
    w.zoomTo(800);
    w.refiner.settle();
    w.zoomTo(1600);
    w.refiner.settle();
    await w.refiner.whenIdle();
    expect(w.events).toHaveLength(1);
    expect(w.events[0]!.nextErrorPx).toBe((0.5 / 1600) * 1600);
    expect(w.events[0]!.priorErrorPx).toBe(TIER0_PX * 1600);
    expect(w.asked.at(-1)!.chord).toBe(0.5 / 1600);
  });

  it("with no readable view (no georeference, no canvas) it does nothing", async () => {
    const w = world();
    w.refiner.start(w.draws);
    w.noView();
    w.refiner.settle();
    await w.refiner.whenIdle();
    expect(w.asked).toEqual([]);
  });
});

describe("#148 the layer emits tier0complete", () => {
  let r: Rig;
  beforeEach(async () => (r = await rig()));
  afterEach(async () => r.stop());
  const cursorOf = (blocks: RawEntity[][]): BlockCursor => {
    let i = 0;
    return { next: () => blocks[i++] ?? null, endsBlock: () => true };
  };

  it("once, after the first full decode, with the number of blocks walked", async () => {
    const layer = createPVecLayer({ id: "t", source: { url: r.url } });
    configureEngine(layer, {
      loadEvaluator: () => Promise.resolve({ instance: {} as WebAssembly.Instance, abiVersion: 2, source: "injected" as const }),
      openCursor: () => Promise.resolve(cursorOf([[arc("1", 0.01)], [line("2")]])),
    });
    const seen: { viewportId: string; blocksUsed: number; msSinceAdd: number }[] = [];
    layer.on("tier0complete", (e) => seen.push(e));
    const { gl } = countingGl();
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.blocksUsed).toBe(2);
    expect(seen[0]!.msSinceAdd).toBeGreaterThanOrEqual(0);
    layer.onRemove(fakeMap, gl);
  });

  it("not at all for a file with no strokes to decode", async () => {
    const layer = createPVecLayer({ id: "t", source: { url: r.url } });
    configureEngine(layer, {
      loadEvaluator: () => Promise.resolve({ instance: {} as WebAssembly.Instance, abiVersion: 2, source: "injected" as const }),
      openCursor: () => Promise.resolve(null),
    });
    const seen: unknown[] = [];
    layer.on("tier0complete", (e) => seen.push(e));
    const { gl } = countingGl();
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    expect(seen).toEqual([]);
    layer.onRemove(fakeMap, gl);
  });
});
