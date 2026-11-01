import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlockCursor, RawEntity } from "../../../src/decode/tier0";
import { createPVecLayer } from "../../../src/index";
import { configureEngine } from "../../../src/layer/internal";
import type { ExactQuery } from "../../../src/layer/query";
import { PVecLayerError } from "../../../src/api/errors";
import { countingGl, fakeMap, rig, type Rig } from "../api/helpers";

// Issue 150: attachQuery has a caller. The layer builds the query engine once the first Tier 0 decode is done and drops it on removal.
let r: Rig;
beforeEach(async () => (r = await rig()));
afterEach(async () => r.stop());

const line: RawEntity = { entityId: "7", kind: "preview", geometry: { type: "polyline", points: [0, 0, 10, 0] }, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 0 }, declaredErrorPx: 1 };
const cursorOf = (): BlockCursor => {
  let done = false;
  return { next: () => (done ? null : ((done = true), [line])), endsBlock: () => true };
};
const exactStub = (log: string[]): ExactQuery => ({
  distance: (id, x, y) => (log.push(`distance ${id} ${x} ${y}`), 0),
  touches: (id) => (log.push(`touches ${id}`), true),
  close: () => void log.push("close"),
});

function layerWith(log: string[], exact: ExactQuery | null) {
  const layer = createPVecLayer({ id: "q", source: { url: r.url } });
  configureEngine(layer, {
    loadEvaluator: () => Promise.resolve({ instance: {} as WebAssembly.Instance, abiVersion: 2, source: "injected" as const }),
    openCursor: () => Promise.resolve(cursorOf()),
    openDistance: () => Promise.resolve(exact),
  });
  return layer;
}

describe("#150 the layer attaches a query engine", () => {
  it("before the load the calls throw disposed; after it they answer; after removal they throw again and the module's file is closed once", async () => {
    const log: string[] = [];
    const layer = layerWith(log, exactStub(log));
    const { gl } = countingGl();
    expect(() => layer.nearestEntity({ lng: 0, lat: 0 }, 5)).toThrow(PVecLayerError);
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    // no georeference, so there is no position to look at: the answer is empty, not an error
    expect(layer.nearestEntity({ lng: 0, lat: 0 }, 5)).toBeUndefined();
    expect(layer.pickPoint({ lng: 0, lat: 0 })).toEqual([]);
    layer.onRemove(fakeMap, gl);
    expect(() => layer.pickPoint({ lng: 0, lat: 0 })).toThrow(PVecLayerError);
    expect(log.filter((l) => l === "close")).toHaveLength(1);
  });

  it("a module without the distance exports leaves the calls throwing, as before", async () => {
    const layer = layerWith([], null);
    const { gl } = countingGl();
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    expect(() => layer.nearestEntity({ lng: 0, lat: 0 }, 5)).toThrow(PVecLayerError);
    layer.onRemove(fakeMap, gl);
  });
});
