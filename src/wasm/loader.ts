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

/** The ABI versions of libviprs/pvec `pvec-wasm` (docs/WASM_ABI.md there) this package knows how to drive. */
export const SUPPORTED_ABI_VERSIONS: readonly number[] = [2];

/**
 * Every export the packed binding calls, plus `memory` and the allocator the generated glue uses to
 * pass byte slices in. A module that lacks one is refused whole, whatever its version says.
 */
export const REQUIRED_EXPORTS: readonly string[] = [
  "memory", "__wbindgen_malloc", "wasm_abi_version", "open", "query_viewport", "batch_len", "batch_truncated",
  "tessellate_batch", "buffer_len", "buffer_ptr", "buffer_elem", "tessellation_failed", "tessellation_conformance",
  "tessellation_origin_x", "tessellation_origin_y", "memory_epoch", "view_current", "force_grow", "release",
  // ABI 2: the spatial directory and the Tier 0 stream (libviprs/pvec#201).
  "directory_stat", "directory_bound", "directory_query", "cells_len", "cells_ptr", "cells_elem", "tier0_viewport", "tier0_stat",
  "tier0_buffer_len", "tier0_buffer_ptr", "tier0_buffer_elem",
];

const fail = (why: string, cause?: unknown): PVecError =>
  new PVecError("wasm_unavailable", `the PVec WASM evaluator is unavailable: ${why}`, { cause: String(cause ?? "") });

/**
 * Acquires the shared Rust evaluator. Nothing runs at import time; the fetch happens here, once.
 * Every failure is a `wasm_unavailable` PVecError and there is no TypeScript geometry fallback.
 */
export async function loadEvaluator(options: WasmOptions = {}, env: WasmEnv = {}): Promise<Evaluator> {
  // The one import wasm-bindgen leaves in the module: it fills the externref table the module
  // starts with. It runs from `__wbindgen_start`, once the instance exists.
  let exports: WebAssembly.Exports | undefined;
  const imports: WebAssembly.Imports = {
    "./pvec_wasm_bg.js": {
      __wbindgen_init_externref_table: () => {
        const table = exports?.["__wbindgen_externrefs"] as WebAssembly.Table | undefined;
        if (!table) return;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
      },
    },
  };
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
  const missing = REQUIRED_EXPORTS.filter((name) => !(name in instance.exports));
  if (missing.length > 0) throw fail(`the module lacks the export${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`);
  const abi = instance.exports["wasm_abi_version"];
  if (typeof abi !== "function") throw fail("wasm_abi_version is not a function");
  exports = instance.exports;
  const start = instance.exports["__wbindgen_start"];
  try {
    if (typeof start === "function") start();
  } catch (e) {
    throw fail(`the module did not start (${e instanceof Error ? e.message : String(e)})`, e);
  }
  const abiVersion = abi() as number;
  if (!SUPPORTED_ABI_VERSIONS.includes(abiVersion)) {
    throw fail(`it speaks ABI version ${abiVersion}, this package drives ${SUPPORTED_ABI_VERSIONS.join(", ")}`);
  }
  return { instance, abiVersion, source };
}

/** Shared memory only where the deployment is cross-origin isolated; transferable buffers otherwise. */
export function chooseTransport(g: { crossOriginIsolated?: boolean; SharedArrayBuffer?: unknown } = globalThis): "shared" | "transfer" {
  return g.crossOriginIsolated === true && typeof g.SharedArrayBuffer === "function" ? "shared" : "transfer";
}
