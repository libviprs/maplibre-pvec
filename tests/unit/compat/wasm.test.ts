import { describe, expect, it } from "vitest";
import { chooseTransport, loadEvaluator, PROBE_WASM_BYTES } from "../../../src/wasm/loader";
import { PVecError } from "../../../src/source/errors";

const bytesResponse = (type = "application/wasm"): Response =>
  new Response(PROBE_WASM_BYTES as BodyInit, { headers: { "content-type": type } });

describe("#31 M7.6 WASM acquisition", () => {
  it("default mode resolves the asset from import.meta.url, same origin, and fetches it once", async () => {
    const seen: string[] = [];
    const ev = await loadEvaluator({}, { fetch: async (u) => (seen.push(String(u)), bytesResponse()) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/pvec_eval\.wasm$/);
    expect(ev.abiVersion).toBe(0);
    expect(ev.source).toBe("default");
  });

  it("explicit wasmUrl is used verbatim", async () => {
    const seen: string[] = [];
    const ev = await loadEvaluator({ wasmUrl: "https://cdn.example/x/pvec_eval.abc123.wasm" }, { fetch: async (u) => (seen.push(String(u)), bytesResponse()) });
    expect(seen).toEqual(["https://cdn.example/x/pvec_eval.abc123.wasm"]);
    expect(ev.source).toBe("explicit");
  });

  it("a wrong content-type falls back to arrayBuffer compile instead of failing", async () => {
    const ev = await loadEvaluator({}, { fetch: async () => bytesResponse("application/octet-stream") });
    expect(ev.abiVersion).toBe(0);
  });

  it("injected wasmModule never touches fetch (strict CSP)", async () => {
    const wasmModule = await WebAssembly.compile(PROBE_WASM_BYTES);
    const ev = await loadEvaluator({ wasmModule }, { fetch: async () => { throw new Error("fetch must not run"); } });
    expect(ev.source).toBe("injected");
  });

  it("injected instantiate hook receives the imports and its instance is used", async () => {
    let got: unknown;
    const ev = await loadEvaluator(
      { instantiate: async (imports) => ((got = imports), (await WebAssembly.instantiate(PROBE_WASM_BYTES, imports)).instance) },
      { fetch: async () => { throw new Error("fetch must not run"); } },
    );
    expect(got).toEqual({});
    expect(ev.source).toBe("injected");
  });

  it("a blocked fetch rejects with wasm_unavailable, once, with no fallback", async () => {
    const e = await loadEvaluator({}, { fetch: async () => { throw new TypeError("blocked by CSP"); } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PVecError);
    expect((e as PVecError).code).toBe("wasm_unavailable");
    expect((e as PVecError).message).toContain("blocked by CSP");
  });

  it("a non-2xx response, a compile failure and a bad ABI all reject with wasm_unavailable", async () => {
    const codes = await Promise.all([
      loadEvaluator({}, { fetch: async () => new Response("nope", { status: 404 }) }),
      loadEvaluator({}, { fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/wasm" } }) }),
      loadEvaluator({ instantiate: async () => ({ exports: {} }) as WebAssembly.Instance }),
    ].map((p) => p.catch((x: PVecError) => x.code)));
    expect(codes).toEqual(["wasm_unavailable", "wasm_unavailable", "wasm_unavailable"]);
  });

  it("shared memory only when crossOriginIsolated, otherwise transferable buffers", () => {
    expect(chooseTransport({ crossOriginIsolated: true, SharedArrayBuffer: class {} })).toBe("shared");
    expect(chooseTransport({ crossOriginIsolated: false, SharedArrayBuffer: class {} })).toBe("transfer");
    expect(chooseTransport({ crossOriginIsolated: true })).toBe("transfer");
    expect(chooseTransport({})).toBe("transfer");
  });

  it("importing the entry fetches nothing and has no side effects", async () => {
    const f = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => (calls++, new Response())) as typeof fetch;
    try {
      await import("../../../src/wasm/index");
      await import("../../../src/style/index");
      await import("../../../src/text/index");
      await import("../../../src/hatch/index");
    } finally {
      globalThis.fetch = f;
    }
    expect(calls).toBe(0);
  });
});
