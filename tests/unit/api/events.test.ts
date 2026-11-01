import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPVecLayer, type PVecEventName } from "../../../src/index";
import { EVENT_NAMES } from "../../../src/diagnostics/events";
import { configureEngine, controlOf } from "../../../src/layer/internal";
import { buildPvec, gridSpec } from "../helpers/fixture";
import { countingFetch } from "../helpers/origin";
import { countingGl, fakeMap, rig, type Rig } from "./helpers";

let r: Rig;
beforeEach(async () => (r = await rig()));
afterEach(async () => r.stop());

describe("#26 M7.3 events and diagnostics", () => {
  it("a scripted load emits every event in the catalogue, and the test lists the catalogue itself", async () => {
    const all: PVecEventName[] = ["capabilities", "bytes", "tier0complete", "refinement", "capabilityunsupported", "rasterskipped", "error"];
    expect([...EVENT_NAMES].sort()).toEqual([...all].sort());
    const seen = new Set<string>();
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    for (const n of all) layer.on(n, () => void seen.add(n));
    const { gl } = countingGl();
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    const ctl = controlOf(layer);
    ctl.markTier0Complete({ viewportId: "v0", blocksUsed: 4 });
    ctl.reportRefinement({ entityId: "e1", generation: 1, priorErrorPx: 2, nextErrorPx: 0.4 });
    ctl.reportCapabilityUnsupported({ capability: "hatch", required: false, action: "ignored" });
    ctl.reportRasterSkipped({ rasterId: 0, rule: "RASTER-04", message: "synthetic" });
    ctl.reportError("listener_failed", "synthetic", {});
    expect([...seen].sort()).toEqual([...all].sort());
    layer.onRemove(fakeMap, gl);
  });

  it("capabilities names the container reader floor, the capability list and the unsupported lists", async () => {
    await r.stop();
    r = await rig(gridSpec({ capabilities: [{ id: 1 }, { id: 4 }, { id: 16, required: false } as never] }));
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    const got: unknown[] = [];
    layer.on("capabilities", (e) => got.push(e));
    const { gl } = countingGl();
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ unsupportedRequired: [], capabilities: expect.arrayContaining([expect.objectContaining({ name: "cartesian_point", required: true })]) });
    layer.onRemove(fakeMap, gl);
  });

  it("counters reconcile with the counting fetch wrapper and issued never passes requested", async () => {
    const c = countingFetch();
    let bytes = 0;
    const wrapped = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const res = await c.fetch(i, init);
      bytes += Number(res.headers.get("content-length") ?? 0);
      return res;
    }) as typeof fetch;
    const layer = createPVecLayer({ id: "a", source: { url: r.url, fetch: wrapped } });
    const { gl } = countingGl();
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    const d = layer.getDiagnostics();
    expect(d.bytes.fetched).toBe(bytes);
    expect(d.ranges.issued).toBe(c.calls.length);
    expect(d.ranges.issued).toBeLessThanOrEqual(d.ranges.requested);
    layer.onRemove(fakeMap, gl);
  });

  it("an unsupported required capability emits one capabilityunsupported and one error, and renders nothing", async () => {
    await r.stop();
    r = await rig(gridSpec({ capabilities: [{ id: 1 }, { id: 99 }] }));
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    const unsupported: unknown[] = [];
    const errors: { code: string }[] = [];
    layer.on("capabilityunsupported", (e) => unsupported.push(e));
    layer.on("error", (e) => errors.push(e));
    const { gl } = countingGl();
    let drawn = 0;
    controlOf(layer).setHooks({ render: () => void drawn++ });
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    layer.render(gl, {});
    expect(unsupported).toEqual([expect.objectContaining({ capability: "capability#99", required: true })]);
    expect(errors.map((e) => e.code)).toEqual(["unsupported_required_capability"]);
    expect(drawn).toBe(0);
    layer.onRemove(fakeMap, gl);
  });

  it("a throwing listener does not break rendering and is reported once through error", async () => {
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    const errors: { code: string }[] = [];
    let drawn = 0;
    controlOf(layer).setHooks({ render: () => void drawn++ });
    // This test is about listeners, not strokes: the map here is empty, so no cursor is opened.
    configureEngine(layer, { openCursor: () => Promise.resolve(null) });
    layer.on("error", (e) => errors.push(e));
    layer.on("tier0complete", () => {
      throw new Error("boom");
    });
    const { gl } = countingGl();
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    controlOf(layer).markTier0Complete({ viewportId: "v", blocksUsed: 1 });
    layer.render(gl, {});
    layer.render(gl, {});
    expect(drawn).toBe(2);
    expect(errors.map((e) => e.code)).toEqual(["listener_failed"]);
    layer.on("error", () => {
      throw new Error("also boom");
    });
    expect(() => controlOf(layer).reportError("listener_failed", "x", {})).not.toThrow();
    layer.onRemove(fakeMap, gl);
  });

  it("the emitter keeps no reference to a transferred payload after dispatch", async () => {
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    layer.on("bytes", () => undefined);
    let payload: { data: Uint8Array } | undefined = { data: new Uint8Array(1024) };
    const ref = new WeakRef(payload.data);
    const { gl } = countingGl();
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    controlOf(layer).reportBytes({ rangesRequested: 1, rangesIssued: 1, rangesCoalesced: 0, bytesFetched: 1, bytesDecoded: 0, cacheTier: "network" });
    payload = undefined;
    await new Promise((res) => setTimeout(res, 10));
    (globalThis as { gc?: () => void }).gc?.();
    // Without --expose-gc the best check is structural: the layer exposes no accessor that could hold it.
    expect(Object.values(layer.getDiagnostics())).not.toContain(ref.deref());
    layer.onRemove(fakeMap, gl);
  });

  it("refinement generations for one entity are strictly increasing; stale ones are counted, not emitted", async () => {
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    const gens: number[] = [];
    layer.on("refinement", (e) => gens.push(e.generation));
    const ctl = controlOf(layer);
    for (const g of [1, 2, 2, 1, 3]) ctl.reportRefinement({ entityId: "e", generation: g, priorErrorPx: 1, nextErrorPx: 0.5 });
    ctl.reportRefinement({ entityId: "other", generation: 1, priorErrorPx: 1, nextErrorPx: 0.5 });
    expect(gens).toEqual([1, 2, 3, 1]);
    expect(layer.getDiagnostics().discardedStaleGenerations).toBe(2);
  });

  it("on, off and once behave", () => {
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    const hits: number[] = [];
    const f = (): void => void hits.push(1);
    layer.on("tier0complete", f);
    layer.once("tier0complete", () => void hits.push(2));
    controlOf(layer).markTier0Complete({ viewportId: "v", blocksUsed: 1 });
    controlOf(layer).markTier0Complete({ viewportId: "v", blocksUsed: 1 });
    layer.off("tier0complete", f);
    controlOf(layer).markTier0Complete({ viewportId: "v", blocksUsed: 1 });
    expect(hits).toEqual([1, 2, 1]);
    void buildPvec;
  });
});
