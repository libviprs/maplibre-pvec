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
  // A handle is an i32 on the wire. The ABI's error codes are -1 to -11 (-11 is a batch past the vertex bound, libviprs/pvec#236); pvec-wasm lets a handle's
  // generation grow into the sign bit after 32768 reuses of a slot (libviprs/pvec#203), which reads as a
  // large negative number. Anything below -11 is such a handle, so give it back as the unsigned number it is.
  const handle = (r: number): number => (r < -11 ? r >>> 0 : r);
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
      return handle(call("open", ptr, len));
    },
    queryViewport(file: number, minX: number, minY: number, maxX: number, maxY: number, budget: number): number {
      return handle(call("query_viewport", file, minX, minY, maxX, maxY, budget));
    },
    batchLength: (batch: number): number => call("batch_len", batch),
    batchTruncated: (batch: number): boolean => call("batch_truncated", batch) === 1,
    /** `chain` is the 15 numbers of the ABI: two affine maps, pixel ratio, screen error, world error. */
    tessellate(batch: number, chain: readonly number[], maxSegments: number, precision: "f64" | "f32"): number {
      const [ptr, len] = put(new Float64Array(chain), 8);
      return handle(call("tessellate_batch", batch, ptr, len, maxSegments, precision === "f64" ? 0 : 1));
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
    /** The spatial directory of a file: stat 0 is 1 when it has one (P5.1). A negative number is an ABI code. */
    directoryStat: (file: number, which: number): number => call("directory_stat", file, which),
    /** Leaves of the directory that touch the window: cell ids, hot entities, Tier 0 flags, stored bytes, boxes. */
    directoryQuery(file: number, minX: number, minY: number, maxX: number, maxY: number): { handle: number; cells: Uint32Array; entities: Uint32Array; hasTier0: Uint32Array; bytes: Float64Array; boxes: Float64Array } | number {
      const r = handle(call("directory_query", file, minX, minY, maxX, maxY));
      if (r < 0) return r;
      const v = <T extends Float64Array | Uint32Array>(ctor: { new (b: ArrayBufferLike, o: number, n: number): T }, which: number): T => {
        const len = call("cells_len", r, which);
        return new ctor(mem().buffer, len === 0 ? 0 : call("cells_ptr", r, which) >>> 0, len);
      };
      return { handle: r, cells: v(Uint32Array, 0), entities: v(Uint32Array, 1), hasTier0: v(Uint32Array, 2), bytes: v(Float64Array, 3), boxes: v(Float64Array, 4) };
    },
    /** One corner of a box of the directory: 0 to 3 the whole tree, 4 to 7 the advanced curves. NaN when there is none. */
    directoryBound: (file: number, which: number): number => call("directory_bound", file, which),
    /** The Tier 0 stream of a window (P5.4): entity ids, codes, declared world error, vertex offsets, vertices. */
    tier0Viewport(file: number, minX: number, minY: number, maxX: number, maxY: number): number {
      return handle(call("tier0_viewport", file, minX, minY, maxX, maxY));
    },
    /** The Tier 0 stream of one leaf (libviprs/pvec#238), without a window. Only a module that exports `tier0_leaf` has it: test `hasLeafCalls`. */
    tier0Leaf(file: number, cell: number): number {
      return handle(call("tier0_leaf", file, cell));
    },
    /** A page of one leaf's entities, ascending by id, as a batch (libviprs/pvec#238). Cell 0 is the advanced curves. */
    queryLeaf(file: number, cell: number, first: number, count: number): number {
      return handle(call("query_leaf", file, cell, first, count));
    },
    /** Whether the module exports the per-leaf calls `tier0_leaf` and `query_leaf` (additions to ABI 2). */
    hasLeafCalls: typeof x["tier0_leaf"] === "function" && typeof x["query_leaf"] === "function",
    /** 0 entries, 1 exact, 2 previews, 3 infeasible, 4 uncovered, 5 leaves read, 6 leaves with no block, 7 advanced bounds meet the window. */
    tier0Stat: (result: number, which: number): number => call("tier0_stat", result, which),
    tier0Views(result: number): { ids: Uint32Array; codes: Uint32Array; errors: Float64Array; offsets: Uint32Array; vertices: Float64Array } {
      const v = <T extends Float64Array | Uint32Array>(ctor: { new (b: ArrayBufferLike, o: number, n: number): T }, which: number): T => {
        const len = call("tier0_buffer_len", result, which);
        if (len < 0) throw new Error(`pvec tier0_buffer_len returned ${len}`);
        return new ctor(mem().buffer, len === 0 ? 0 : call("tier0_buffer_ptr", result, which) >>> 0, len);
      };
      return { ids: v(Uint32Array, 0), codes: v(Uint32Array, 1), errors: v(Float64Array, 2), offsets: v(Uint32Array, 3), vertices: v(Float64Array, 4) };
    },
    failed: (result: number): number => call("tessellation_failed", result),
    conformance: (result: number): number => call("tessellation_conformance", result),
    origin: (result: number): [number, number] => [call("tessellation_origin_x", result), call("tessellation_origin_y", result)],
    forceGrow: (): void => void call("force_grow"),
    release: (handle: number): number => call("release", handle),
  };
}
