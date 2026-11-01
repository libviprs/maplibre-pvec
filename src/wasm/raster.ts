import type { RasterPlacement } from "../render/raster/geometry";
import { RasterRefusedError, type RasterProvider } from "../render/raster/provider";
import { RASTER_EXPORTS, type Evaluator } from "./loader";

export { RASTER_EXPORTS } from "./loader";

/** Where the module reads its ranges from: the layer's source. */
export interface RangeReader {
  readRange(offset: number, length: number): Promise<Uint8Array>;
  readonly artifactLength: number | undefined;
}

type Fn = (...a: number[]) => number;
const NEEDS_RANGE = -7;
const NO_RASTER_STREAM = -8, NOT_STORED = -9, SKIPPED = -10;
/** A call that keeps answering -7 is not converging (a hostile file can ask for ranges forever). */
const MAX_ROUNDS = 64;

export const hasRasterExports = (ev: Evaluator): boolean => RASTER_EXPORTS.every((n) => typeof (ev.instance.exports as Record<string, unknown>)[n] === "function");

/**
 * The raster stream of a file behind the module's exports, as the renderer's `RasterProvider`. The module opens the file by byte
 * ranges (issue #205): a call that needs bytes it has not got answers -7, names the ranges, and is made again once they are provided.
 * Resolves to null when the module lacks the raster exports, or the file has no raster stream. Pixels are never touched here: tiles
 * are the encoded bytes after the module's own checks, and the browser decodes them.
 */
export async function openRasterProvider(ev: Evaluator, src: RangeReader): Promise<RasterProvider | null> {
  if (!hasRasterExports(ev) || src.artifactLength === undefined) return null;
  const x = ev.instance.exports as unknown as Record<string, Fn> & { memory: WebAssembly.Memory };
  const call = (name: string, ...a: number[]): number => (x[name] as Fn)(...a);
  // one call at a time: the ranges a -7 names belong to the call that asked
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = chain.then(f, f);
    chain = next.catch(() => undefined);
    return next;
  };
  const provide = async (h: number): Promise<void> => {
    const n = call("needed_count", h);
    const want: [number, number][] = [];
    for (let i = 0; i < n; i++) want.push([call("needed_offset", h, i), call("needed_len", h, i)]);
    for (const [off, len] of want) {
      const bytes = await src.readRange(off, len);
      const ptr = call("__wbindgen_malloc", bytes.length, 1) >>> 0;
      new Uint8Array(x.memory.buffer).set(bytes, ptr);
      const r = call("provide_range", h, off, ptr, bytes.length);
      if (r < 0) throw new Error(`provide_range answered ${r}`);
    }
  };
  /** `fn` until it stops answering -7, providing what each -7 names. `h` is the handle whose ranges are named. */
  const until = async (h: () => number, fn: () => number): Promise<number> => {
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const r = fn();
      if (r !== NEEDS_RANGE) return r;
      await provide(h());
    }
    throw new Error("the module kept asking for ranges");
  };

  const opening = call("open_ranged", src.artifactLength);
  if (opening < 0) return null;
  const file = await serial(async () => {
    const r = await until(() => opening, () => call("open_poll", opening));
    if (r < 0) throw new Error(`open_poll answered ${r}`);
    return r >>> 0;
  });
  const stat = (n: number): Promise<number> => until(() => file, () => call("raster_stat", file, n));
  if ((await serial(() => stat(3))) !== 1) return null;
  const count = await serial(() => stat(0));
  if (count <= 0) {
    // A raster stream the rules refuse as a whole holds no raster ids (WASM_ABI.md, issue 232): selectors 4 and 5 of raster_stat name the
    // rule and its family. The provider has no placements and says why; the layer treats it as a file without rasters.
    const rule = await serial(() => stat(4));
    if (rule <= 0) return null;
    const name = `${(await serial(() => stat(5))) === 1 ? "LIMIT" : "RASTER"}-${String(rule).padStart(2, "0")}`;
    return { placements: () => [], tile: () => Promise.resolve(null), refusedStream: { rule: name, message: `${name}: the module refused the raster stream as a whole` }, release: () => void call("release", file) };
  }

  /** The rule a skipped raster names, as `RASTER-0N` or `LIMIT-0N`: selector 2 is the family (an older build answers -3, which is RASTER). */
  const skippedList = async (): Promise<{ id: number; rule: string; message: string }[]> => {
    const n = await stat(1);
    const out: { id: number; rule: string; message: string }[] = [];
    for (let i = 0; i < n; i++) {
      const id = call("raster_skipped", file, i, 0), rule = call("raster_skipped", file, i, 1);
      const name = `${call("raster_skipped", file, i, 2) === 1 ? "LIMIT" : "RASTER"}-${String(rule).padStart(2, "0")}`;
      out.push({ id, rule: name, message: `${name}: the module skipped raster ${id}` });
    }
    return out;
  };
  const initialSkips = await serial(skippedList);
  const skippedIds = new Set(initialSkips.map((s) => s.id));
  const placements: RasterPlacement[] = [];
  const text = new TextDecoder("utf-8", { fatal: false });
  for (let r = 0; r < count; r++) {
    if (skippedIds.has(r)) continue;
    const res = await serial(() => until(() => file, () => call("raster_placement", file, r)));
    if (res < 0) continue; // skipped by a rule: reported through skipped()
    const h = res >>> 0;
    const arr = (which: number) => {
      const len = call("raster_buffer_len", h, which);
      return { len, ptr: len > 0 ? call("raster_buffer_ptr", h, which) >>> 0 : 0 };
    };
    const a0 = arr(0), a1 = arr(1), a2 = arr(2);
    const f = new Float64Array(x.memory.buffer, a0.ptr, a0.len).slice();
    const u = new Uint32Array(x.memory.buffer, a1.ptr, a1.len).slice();
    const attribution = a2.len ? text.decode(new Uint8Array(x.memory.buffer, a2.ptr, a2.len).slice()) : undefined;
    call("release", h);
    placements.push({
      id: r,
      pixelToSource: [f[0]!, f[1]!, f[2]!, f[3]!, f[4]!, f[5]!],
      width: u[0]!,
      height: u[1]!,
      visibleBox: [u[2]!, u[3]!, u[4]!, u[5]!],
      tileEdge: u[6]!,
      levels: u[7]!,
      codec: u[8]!,
      channels: u[9] as 1 | 2 | 3 | 4,
      bitDepth: u[10] as 1 | 8,
      opacity: u[11]!,
      band: u[12] as 0 | 1,
      ...(attribution ? { attribution } : {}),
    });
  }

  return {
    placements: () => placements,
    skipped: () => initialSkips,
    tile: (id, level, col, row) =>
      serial(async () => {
        const res = await until(() => file, () => call("raster_tile", file, id, level, col, row));
        if (res === NOT_STORED) return null;
        if (res === SKIPPED || res === NO_RASTER_STREAM) {
          // a tile the module refused when it was read adds its raster to the skipped list, with the rule
          const hit = (await skippedList()).find((s) => s.id === id);
          throw new RasterRefusedError(hit?.rule ?? "RASTER-03", hit?.message ?? `RASTER-03: the module refused a tile of raster ${id}`);
        }
        if (res < 0) throw new Error(`raster_tile answered ${res}`);
        const h = res >>> 0;
        try {
          const len = call("raster_buffer_len", h, 0);
          const ptr = len > 0 ? call("raster_buffer_ptr", h, 0) >>> 0 : 0;
          return new Uint8Array(x.memory.buffer, ptr, len).slice();
        } finally {
          // releasing the handle also drops the tile's range from the module (WASM_ABI.md, "Cache policy")
          call("release", h);
        }
      }),
    release: () => void call("release", file),
  };
}
