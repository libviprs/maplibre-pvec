import { PVecError } from "../source/errors";

export interface WasmOptions {
  /** Explicit URL for CDN or hashed-asset deployments. */
  wasmUrl?: string;
  /** A compiled module, for strict CSP deployments that never let the page fetch or compile. */
  wasmModule?: WebAssembly.Module;
  /** Full control: build the instance yourself from the imports this package passes. */
  instantiate?: (imports: WebAssembly.Imports) => Promise<WebAssembly.Instance>;
}

export interface Evaluator {
  readonly instance: WebAssembly.Instance;
  readonly abiVersion: number;
  readonly source: "default" | "explicit" | "injected";
}

export interface WasmEnv {
  fetch?: (url: string | URL) => Promise<Response>;
}

const fail = (why: string, cause?: unknown): PVecError =>
  new PVecError("wasm_unavailable", `the PVec WASM evaluator is unavailable: ${why}`, { cause: String(cause ?? "") });

/**
 * Acquires the shared Rust evaluator. Nothing runs at import time; the fetch happens here, once.
 * Every failure is a `wasm_unavailable` PVecError and there is no TypeScript geometry fallback.
 */
export async function loadEvaluator(options: WasmOptions = {}, env: WasmEnv = {}): Promise<Evaluator> {
  const imports: WebAssembly.Imports = {};
  let instance: WebAssembly.Instance;
  let source: Evaluator["source"] = "default";
  try {
    if (options.instantiate) {
      source = "injected";
      instance = await options.instantiate(imports);
    } else if (options.wasmModule) {
      source = "injected";
      instance = await WebAssembly.instantiate(options.wasmModule, imports);
    } else {
      source = options.wasmUrl ? "explicit" : "default";
      const url = options.wasmUrl ?? new URL("./pvec_eval.wasm", import.meta.url).href;
      const res = await (env.fetch ?? fetch)(url);
      if (!res.ok) throw fail(`${url} answered ${res.status}`);
      const type = res.headers.get("content-type") ?? "";
      if (type.startsWith("application/wasm") && typeof WebAssembly.instantiateStreaming === "function") {
        instance = (await WebAssembly.instantiateStreaming(res, imports)).instance;
      } else {
        instance = (await WebAssembly.instantiate(await res.arrayBuffer(), imports)).instance;
      }
    }
  } catch (e) {
    if (e instanceof PVecError) throw e;
    throw fail(e instanceof Error ? e.message : String(e), e);
  }
  const abi = instance.exports["pvec_abi_version"];
  if (typeof abi !== "function") throw fail("the module does not export pvec_abi_version");
  return { instance, abiVersion: abi() as number, source };
}

/** Shared memory only where the deployment is cross-origin isolated; transferable buffers otherwise. */
export function chooseTransport(g: { crossOriginIsolated?: boolean; SharedArrayBuffer?: unknown } = globalThis): "shared" | "transfer" {
  return g.crossOriginIsolated === true && typeof g.SharedArrayBuffer === "function" ? "shared" : "transfer";
}
