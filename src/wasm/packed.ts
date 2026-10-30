import type { Evaluator } from "./loader";

export { REQUIRED_EXPORTS, SUPPORTED_ABI_VERSIONS } from "./loader";

/** The four arrays of a packed tessellation, as views over the module's linear memory. */
export interface PackedViews {
  vertices: Float64Array | Float32Array;
  offsets: Uint32Array;
  entityIds: Uint32Array;
  styleRefs: Uint32Array;
  /** False once the memory has grown since these views were made: they are detached, make them again. */
  current(): boolean;
}

type Fn = (...a: number[]) => number;

/**
 * A typed face over the exports of libviprs/pvec `pvec-wasm` (docs/WASM_ABI.md there). Every call is a
 * number in and a number out, a negative number being the ABI error code. Nothing here evaluates a
 * curve: the arithmetic is the module's.
 */
export function bindPacked(ev: Evaluator) {
  const x = ev.instance.exports as unknown as Record<string, Fn> & { memory: WebAssembly.Memory };
  const call = (name: string, ...a: number[]): number => (x[name] as Fn)(...a);
  const mem = (): WebAssembly.Memory => x.memory;
  const put = (src: Uint8Array | Float64Array, align: number): [number, number] => {
    const bytes = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    const ptr = call("__wbindgen_malloc", bytes.length, align) >>> 0;
    new Uint8Array(mem().buffer).set(bytes, ptr);
    return [ptr, src.length];
  };
  const view = <T extends Float64Array | Float32Array | Uint32Array>(
    ctor: { new (b: ArrayBufferLike, o: number, n: number): T },
    result: number,
    which: number,
  ): T => {
    const len = call("buffer_len", result, which);
    if (len < 0) throw new Error(`pvec buffer_len returned ${len}`);
    return new ctor(mem().buffer, len === 0 ? 0 : call("buffer_ptr", result, which) >>> 0, len);
  };
  return {
    /** A file handle, or a negative ABI code. The module copies nothing it does not need: pass the whole file. */
    open(bytes: Uint8Array): number {
      const [ptr, len] = put(bytes, 1);
      return call("open", ptr, len);
    },
    queryViewport(file: number, minX: number, minY: number, maxX: number, maxY: number, budget: number): number {
      return call("query_viewport", file, minX, minY, maxX, maxY, budget);
    },
    batchLength: (batch: number): number => call("batch_len", batch),
    batchTruncated: (batch: number): boolean => call("batch_truncated", batch) === 1,
    /** `chain` is the 15 numbers of the ABI: two affine maps, pixel ratio, screen error, world error. */
    tessellate(batch: number, chain: readonly number[], maxSegments: number, precision: "f64" | "f32"): number {
      const [ptr, len] = put(new Float64Array(chain), 8);
      return call("tessellate_batch", batch, ptr, len, maxSegments, precision === "f64" ? 0 : 1);
    },
    views(result: number): PackedViews {
      const epoch = call("memory_epoch");
      const f32 = call("buffer_elem", result, 0) === 1;
      return {
        vertices: f32 ? view(Float32Array, result, 0) : view(Float64Array, result, 0),
        offsets: view(Uint32Array, result, 1),
        entityIds: view(Uint32Array, result, 2),
        styleRefs: view(Uint32Array, result, 3),
        current: () => call("memory_epoch") === epoch,
      };
    },
    failed: (result: number): number => call("tessellation_failed", result),
    conformance: (result: number): number => call("tessellation_conformance", result),
    origin: (result: number): [number, number] => [call("tessellation_origin_x", result), call("tessellation_origin_y", result)],
    forceGrow: (): void => void call("force_grow"),
    release: (handle: number): number => call("release", handle),
  };
}
