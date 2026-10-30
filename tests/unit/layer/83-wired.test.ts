import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPVecLayer } from "../../../src/index";
import { configureEngine } from "../../../src/layer/internal";
import { PVecError } from "../../../src/source/errors";
import { countingFetch } from "../helpers/origin";
import { countingGl, fakeMap, rig, type Rig } from "../api/helpers";

let r: Rig;
beforeEach(async () => (r = await rig()));
afterEach(async () => r.stop());

const evaluator = { instance: {} as WebAssembly.Instance, abiVersion: 1, source: "injected" as const };

describe("#83 the layer refuses before it touches the network", () => {
  it("wasm_unavailable: one error event, zero range requests, render is a no-op, onAdd does not throw", async () => {
    const c = countingFetch();
    const layer = createPVecLayer({ id: "a", source: { url: r.url, fetch: c.fetch } });
    configureEngine(layer, {
      loadEvaluator: () => Promise.reject(new PVecError("wasm_unavailable", "the PVec WASM evaluator is unavailable: blocked")),
    });
    const errors: { code: string }[] = [];
    layer.on("error", (e) => errors.push(e));
    const { gl } = countingGl();
    expect(() => layer.onAdd(fakeMap, gl)).not.toThrow();
    await layer.whenReady();
    expect(() => layer.render(gl, {})).not.toThrow();
    expect(errors.map((e) => e.code)).toEqual(["wasm_unavailable"]);
    expect(c.calls).toHaveLength(0);
    layer.onRemove(fakeMap, gl);
    expect(errors).toHaveLength(1);
  });

  it("unsupported_maplibre_version: one error, no evaluator load, no request", async () => {
    const c = countingFetch();
    const layer = createPVecLayer({ id: "a", source: { url: r.url, fetch: c.fetch } });
    let loaded = 0;
    configureEngine(layer, {
      maplibreVersion: () => "3.6.2",
      loadEvaluator: () => (loaded++, Promise.resolve(evaluator)),
    });
    const errors: { code: string }[] = [];
    layer.on("error", (e) => errors.push(e));
    const { gl } = countingGl();
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    expect(errors.map((e) => e.code)).toEqual(["unsupported_maplibre_version"]);
    expect(loaded).toBe(0);
    expect(c.calls).toHaveLength(0);
    layer.onRemove(fakeMap, gl);
  });

  it("webgl2_required: one error and no request when the context is not WebGL2", async () => {
    const c = countingFetch();
    const layer = createPVecLayer({ id: "a", source: { url: r.url, fetch: c.fetch } });
    configureEngine(layer, { loadEvaluator: () => Promise.resolve(evaluator) });
    const errors: { code: string }[] = [];
    layer.on("error", (e) => errors.push(e));
    const gl = { canvas: new EventTarget() } as unknown as WebGL2RenderingContext;
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    expect(errors.map((e) => e.code)).toEqual(["webgl2_required"]);
    expect(c.calls).toHaveLength(0);
    layer.onRemove(fakeMap, gl);
  });

  it("a working evaluator and a WebGL2 context emit no error and do bootstrap", async () => {
    const c = countingFetch();
    const layer = createPVecLayer({ id: "a", source: { url: r.url, fetch: c.fetch } });
    configureEngine(layer, { loadEvaluator: () => Promise.resolve(evaluator), openCursor: () => Promise.resolve(null) });
    const errors: unknown[] = [];
    layer.on("error", (e) => errors.push(e));
    const { gl } = countingGl();
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    expect(errors).toEqual([]);
    expect(c.calls.length).toBeGreaterThan(0);
    layer.onRemove(fakeMap, gl);
  });
});

describe("#83 one name for the capability refusal", () => {
  it("a wrong major of a known required capability uses the same code, with the reason in detail", async () => {
    const { RangeOrigin } = await import("../helpers/origin");
    const { buildPvec, gridSpec } = await import("../helpers/fixture");
    const { PVecSource } = await import("../../../src/source/PVecSource");
    const origin = new RangeOrigin(buildPvec(gridSpec({ capabilities: [{ id: 1, major: 9 }] })).bytes);
    const base = await origin.start();
    const err = (await new PVecSource({ url: `${base}/p.pvec` }).bootstrap().catch((e: unknown) => e)) as PVecError;
    await origin.stop();
    expect(err.code).toBe("unsupported_required_capability");
    expect(err.detail["reason"]).toBe("version");
  });
});
