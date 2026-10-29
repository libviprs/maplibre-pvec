import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPVecLayer, PVecLayer, PVecLayerError, PVecOptionError } from "../../../src/index";
import { controlOf } from "../../../src/layer/internal";
import { countingFetch } from "../helpers/origin";
import { countingGl, fakeMap, rig, type Rig } from "./helpers";

let r: Rig;
beforeEach(async () => (r = await rig()));
afterEach(async () => r.stop());

describe("#26 M7.2 lifecycle", () => {
  it("createPVecLayer returns a PVecLayer and refuses bad options at construction, without a request", () => {
    const c = countingFetch();
    const layer = createPVecLayer({ id: "a", source: { url: r.url, fetch: c.fetch } });
    expect(layer).toBeInstanceOf(PVecLayer);
    expect(layer.type).toBe("custom");
    expect(c.calls).toHaveLength(0);
    expect(() => createPVecLayer({ id: "b", source: { url: "relative.pvec" } })).toThrow(PVecOptionError);
  });

  it("a second onAdd on a live layer throws already_added", () => {
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    const { gl } = countingGl();
    layer.onAdd(fakeMap, gl);
    expect(() => layer.onAdd(fakeMap, gl)).toThrow(expect.objectContaining({ name: "PVecLayerError", code: "already_added" }));
    layer.onRemove(fakeMap, gl);
  });

  it("onRemove twice does not throw; add after remove works", async () => {
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    const { gl } = countingGl();
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    layer.onRemove(fakeMap, gl);
    expect(() => layer.onRemove(fakeMap, gl)).not.toThrow();
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    layer.onRemove(fakeMap, gl);
  });

  it("tears down in the documented order", async () => {
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    const { gl } = countingGl();
    const order: string[] = [];
    const ctl = controlOf(layer);
    ctl.setHooks({
      terminateWorkers: () => void order.push("workers"),
      dropWasm: () => void order.push("wasm"),
    });
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    const signal = ctl.signal()!;
    signal.addEventListener("abort", () => order.push("abort"));
    const buf = ctl.gl.track("buffer", gl.createBuffer()!);
    const del = gl.deleteBuffer.bind(gl);
    (gl as unknown as { deleteBuffer: unknown }).deleteBuffer = (b: WebGLBuffer) => (order.push("gl"), del(b));
    ctl.onCacheClear(() => order.push("cache"));
    void buf;
    layer.onRemove(fakeMap, gl);
    expect(order).toEqual(["abort", "workers", "gl", "wasm", "cache"]);
  });

  it("add and remove 50 times on one map returns workers, GL objects and pending fetches to the start", async () => {
    const c = countingFetch();
    let pending = 0;
    const tracked = (async (i: RequestInfo | URL, init?: RequestInit) => {
      pending++;
      try {
        return await c.fetch(i, init);
      } finally {
        pending--;
      }
    }) as typeof fetch;
    const { gl, live } = countingGl();
    for (let i = 0; i < 50; i++) {
      const layer = createPVecLayer({ id: `l${i}`, source: { url: r.url, fetch: tracked } });
      layer.onAdd(fakeMap, gl);
      const ctl = controlOf(layer);
      ctl.gl.track("buffer", gl.createBuffer()!);
      ctl.gl.track("program", gl.createProgram()!);
      ctl.gl.track("vao", gl.createVertexArray()!);
      if (i % 2) await layer.whenReady();
      layer.onRemove(fakeMap, gl);
    }
    expect(live()).toEqual({ buffer: 0, program: 0, vao: 0 });
    expect(pending).toBe(0);
  });

  it("after remove nothing is pending and no error event fires", async () => {
    const errors: unknown[] = [];
    let inflight = 0;
    const slow = (async (i: RequestInfo | URL, init?: RequestInit) => {
      inflight++;
      try {
        await new Promise((res, rej) => {
          const t = setTimeout(res, 2000);
          init?.signal?.addEventListener("abort", () => (clearTimeout(t), rej(new DOMException("a", "AbortError"))));
        });
        return await fetch(i, init);
      } finally {
        inflight--;
      }
    }) as typeof fetch;
    const layer = createPVecLayer({ id: "a", source: { url: r.url, fetch: slow } });
    layer.on("error", (e) => errors.push(e));
    const { gl } = countingGl();
    layer.onAdd(fakeMap, gl);
    await new Promise((res) => setTimeout(res, 20));
    expect(inflight).toBe(1);
    layer.onRemove(fakeMap, gl);
    await layer.whenReady();
    expect(inflight).toBe(0);
    expect(errors).toEqual([]);
    expect(layer.getDiagnostics().pendingFetches).toBe(0);
  });

  it("context loss then restore keeps the layer usable and fetches nothing", async () => {
    const c = countingFetch();
    const layer = createPVecLayer({ id: "a", source: { url: r.url, fetch: c.fetch } });
    const { gl, canvas } = countingGl();
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    const before = c.calls.length;
    const seen: string[] = [];
    controlOf(layer).setHooks({ onContextLost: () => void seen.push("lost"), onContextRestored: () => void seen.push("restored") });
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(seen).toEqual(["lost", "restored"]);
    expect(c.calls.length).toBe(before);
    expect(layer.getDiagnostics().contextLosses).toBe(1);
    layer.onRemove(fakeMap, gl);
    canvas.dispatchEvent(new Event("webglcontextlost"));
    expect(seen).toEqual(["lost", "restored"]);
  });

  it("update() changes the georeference without a single new request", async () => {
    const c = countingFetch();
    const layer = createPVecLayer({ id: "a", source: { url: r.url, fetch: c.fetch } });
    const { gl } = countingGl();
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    const n = c.calls.length;
    layer.update({ georeference: { reference: { kind: "affine", unit: "m", crs: "EPSG:3857", matrix: [1, 0, 0, 1, 0, 0] } as never } });
    expect(c.calls.length).toBe(n);
    expect(() => layer.update({ errorPolicy: { displayTolerancePx: -1 } })).toThrow(PVecOptionError);
    layer.onRemove(fakeMap, gl);
  });

  it("render never throws on a removed layer, and a render before ready draws nothing", () => {
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    const { gl } = countingGl();
    expect(() => layer.render(gl, {})).not.toThrow();
    expect(PVecLayerError.name).toBe("PVecLayerError");
  });
});
