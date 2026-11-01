import type { BlockCursor, RawEntity } from "../decode/tier0";
import type { PVecHandle } from "../source/bootstrap";
import { PVecError } from "../source/errors";
import type { PVecSource } from "../source/PVecSource";
import type { Evaluator } from "../wasm/loader";
import { bindPacked } from "../wasm/packed";

// The evaluator opens a whole file from memory (its range-callback open waits on pvec's `http` feature), so
// the artifact is read in ranges and handed over in one piece.
const CHUNK = 4 << 20;
// The evaluator sizes its buffers from these, so they are bounds a leaf never reaches rather than the largest number.
const MAX_ENTITIES = 1e7;
const MAX_SEGMENTS = 5e6;
// The width of the whole drawing in screen pixels: a pixel of that view is the asked error, and the unit declared errors are given in.
const FULL_VIEW_PX = 1920;
// The most entities of a leaf that are tessellated in one step, and of the advanced curves (a spline costs more than a segment).
// A step starts small and grows while it stays cheap, and shrinks when it costs more than STEP_MS, down to one entity (a single
// spline of 10^4 control points costs 2 to 8 ms by itself), so one step never holds what a slice cannot.
const PAGE_ENTITIES = 256;
const ADVANCED_PAGE_ENTITIES = 32;
const STEP_MS = 2;
// A window with more entities than this is split in four before it is tessellated (a module without the per-leaf calls).
const STEP_ENTITIES = 512;
const MAX_DEPTH = 12;
// What one `next` call spends before it hands back what it has.
const CALL_MS = 1;
// Stored previews are copied out this many to a step.
const PREVIEW_STEP = 256;

/** `a` to `b` of a vertex array as a plain array. A sized loop is four to five times cheaper than `Array.from` (which grows an array through an iterator), and it makes no garbage to collect inside a slice. */
const copied = (v: ArrayLike<number>, a: number, b: number): number[] => {
  const out = new Array<number>(b - a);
  for (let i = a; i < b; i++) out[i - a] = v[i]!;
  return out;
};

const boundsOf = (p: ArrayLike<number>) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < p.length; i += 2) {
    const x = p[i]!, y = p[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
};

type Box = readonly [number, number, number, number];

/**
 * A cursor over the evaluator's Tier 0 stream of a file held in memory, in steps that each cost the evaluator a few
 * hundred entities, so that the decoder's slices stay short. `window` is the source extent as
 * `[minX, minY, maxX, maxY]`, and an entity outside it is not returned. All of it is display fidelity, so every entity is a
 * `preview`, with its error in pixels of a 1920 pixel view of the window.
 *
 * With a module that has the per-leaf calls (libviprs/pvec#238) and a file that has a spatial directory, the cursor walks the
 * leaves the window touches, one at a time, and a leaf is a block: its stored previews (codes 1 and 2, with their declared error)
 * come from `tier0_leaf`, then its entities a page at a time from `query_leaf`, tessellated at one pixel. Every entity is in one leaf, so none is
 * answered twice, a step costs a page and not the file, and the decoder counts a block against `maxEntitiesPerBlock` where it used to
 * count the whole file. The advanced curves, which no leaf holds, are the last block. With a module that has no per-leaf calls, or a file with no
 * directory, it walks the window in boxes instead: a box holding more than a few hundred entities is split in four first (an
 * entity on a split line is answered once), and the whole walk is one block, as before.
 *
 * The cursor owns the file handle until it is drained, and gives it back on a later turn (not inside the `next` that returns the end of the walk, because freeing a file costs more than a slice may); call `close` to give it back early or at once.
 */
export function tier0CursorOver(evaluator: Evaluator, bytes: Uint8Array, window: readonly [number, number, number, number]): BlockCursor & { close(): void } {
  const rt = bindPacked(evaluator);
  const file = rt.open(bytes);
  if (file < 0) throw new PVecError("load_failed", `the evaluator refused the file (code ${file})`);
  const px = Math.max(window[2] - window[0], window[3] - window[1], 1e-9) / FULL_VIEW_PX;
  const chain = [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1e9, px];
  const hasDirectory = rt.directoryStat(file, 0) === 1;
  const seen = new Set<number>();
  const pending: RawEntity[] = [];
  const meetsWindow = (b: { minX: number; minY: number; maxX: number; maxY: number }): boolean =>
    b.minX <= window[2] && b.maxX >= window[0] && b.minY <= window[3] && b.maxY >= window[1];
  const entity = (id: number, points: number[], declaredErrorPx: number): RawEntity => ({
    entityId: String(id),
    kind: "preview",
    geometry: { type: "polyline", points },
    bounds: boundsOf(points),
    declaredErrorPx,
  });
  /** Tessellates a batch and keeps the entities not answered yet. Releases the batch. */
  const tessellated = (batch: number): void => {
    try {
      const tess = rt.tessellate(batch, chain, MAX_SEGMENTS, "f64");
      if (tess < 0) return;
      try {
        const v = rt.views(tess);
        for (let i = 0; i < v.entityIds.length; i++) {
          const id = v.entityIds[i]!;
          if (seen.has(id)) continue;
          const points = copied(v.vertices, 2 * v.offsets[i]!, 2 * v.offsets[i + 1]!);
          if (points.length < 4) continue;
          const e = entity(id, points, 1);
          if (meetsWindow(e.bounds)) (seen.add(id), pending.push(e));
        }
      } finally {
        rt.release(tess);
      }
    } finally {
      rt.release(batch);
    }
  };
  /** Copies `PREVIEW_STEP` of the stored previews of a Tier 0 result at a time (a yield between), and releases it. */
  function* storedPreviews(stream: number): Generator<void> {
    try {
      const n = rt.tier0Views(stream).ids.length;
      for (let at = 0; at < n; at += PREVIEW_STEP) {
        const v = rt.tier0Views(stream);
        for (let i = at; i < Math.min(n, at + PREVIEW_STEP); i++) {
          const id = v.ids[i]!, code = v.codes[i]!;
          if (seen.has(id) || (code !== 1 && code !== 2)) continue;
          const points = copied(v.vertices, 2 * v.offsets[i]!, 2 * v.offsets[i + 1]!);
          if (points.length < 4) continue;
          const e = entity(id, points, v.errors[i]! / px);
          if (meetsWindow(e.bounds)) (seen.add(id), pending.push(e));
        }
        yield;
      }
    } finally {
      rt.release(stream);
    }
  }
  let page = 16;
  /** One leaf (cell 0: the advanced curves): its stored previews, then its entities a page at a time. */
  function* leaf(cell: number, hasBlock: boolean): Generator<void> {
    if (hasBlock) {
      const stream = rt.tier0Leaf(file, cell);
      yield;
      if (stream >= 0) yield* storedPreviews(stream);
    }
    const cap = cell === 0 ? ADVANCED_PAGE_ENTITIES : PAGE_ENTITIES;
    // The advanced curves are the unknown (a spline can cost a whole slice), so they start at one; a leaf goes on from the last leaf.
    if (cell === 0) page = 1;
    for (let first = 0, asked = 0; ; first += asked) {
      asked = page;
      const began = performance.now();
      const batch = rt.queryLeaf(file, cell, first, asked);
      if (batch < 0) return;
      const more = rt.batchTruncated(batch);
      tessellated(batch);
      const spent = performance.now() - began;
      page = spent > STEP_MS ? Math.max(1, page >> 1) : spent < STEP_MS / 2 ? Math.min(cap, page * 2) : page;
      yield;
      if (!more) return;
    }
  }
  /** A window of a module with no per-leaf calls: its stored previews, then boxes of a few hundred entities. */
  function* box(w: Box, depth: number, top: boolean): Generator<void> {
    if (top && hasDirectory) {
      const stream = rt.tier0Viewport(file, ...w);
      yield;
      if (stream >= 0) yield* storedPreviews(stream);
    }
    const batch = rt.queryViewport(file, ...w, MAX_ENTITIES);
    if (batch < 0) return;
    if (rt.batchLength(batch) > STEP_ENTITIES && depth < MAX_DEPTH && w[2] > w[0] && w[3] > w[1]) {
      rt.release(batch);
      yield;
      const mx = (w[0] + w[2]) / 2, my = (w[1] + w[3]) / 2;
      for (const b of [[w[0], w[1], mx, my], [mx, w[1], w[2], my], [w[0], my, mx, w[3]], [mx, my, w[2], w[3]]] as Box[]) yield* box(b, depth + 1, false);
      return;
    }
    tessellated(batch);
    yield;
  }

  // The blocks to walk, each a generator that yields between steps.
  const blocks: Array<() => Generator<void>> = [];
  if (hasDirectory && rt.hasLeafCalls) {
    const q = rt.directoryQuery(file, ...window);
    if (typeof q !== "number") {
      const cells = Array.from(q.cells), hasTier0 = Array.from(q.hasTier0);
      rt.release(q.handle);
      cells.forEach((cell, i) => blocks.push(() => leaf(cell, hasTier0[i] === 1)));
    }
    const adv = [4, 5, 6, 7].map((n) => rt.directoryBound(file, n));
    if (adv.every(Number.isFinite)) blocks.push(() => leaf(0, false));
  } else {
    blocks.push(() => box([...window], 0, true));
  }
  blocks.reverse();

  let current: Generator<void> | null = null;
  let open = true;
  let consumed = 0;
  let emitted = 0;
  const ends: number[] = [];
  let at = 0;
  let endedNow = false;
  // Freeing a file costs 6 to 40 ms and grows with it, so the walk's last `next` never pays for it: it schedules the release for a later turn.
  let freed = false;
  const free = (): void => {
    if (freed) return;
    freed = true;
    rt.release(file);
  };
  const stop = (): void => {
    open = false;
    current?.return(undefined);
    current = null;
    blocks.length = 0;
  };
  const close = (): void => {
    if (open) stop();
    free();
  };
  const step = (): void => {
    if (!current) {
      const make = blocks.pop();
      if (!make) return;
      current = make();
    }
    const before = pending.length;
    const r = current.next();
    emitted += pending.length - before;
    if (r.done) (current = null, ends.push(emitted));
  };
  return {
    close,
    // True when the entities the last `next` returned end a block, so the decoder counts the next one from zero.
    endsBlock: () => endedNow,
    next(max: number): RawEntity[] | null {
      // A call gives up its turn after a millisecond with whatever it has, which may be nothing: an empty batch is not the end, `null` is.
      const start = performance.now();
      while (pending.length - at < max && (current || blocks.length) && performance.now() - start < CALL_MS) step();
      let n = Math.min(max, pending.length - at);
      if (ends.length) n = Math.min(n, ends[0]! - consumed);
      const slice = pending.slice(at, at + n);
      at += n;
      consumed += n;
      endedNow = false;
      while (ends.length && ends[0]! <= consumed) (ends.shift(), (endedNow = true));
      if (at > 4096) (pending.splice(0, at), (at = 0));
      if (!slice.length && !current && !blocks.length && at >= pending.length) return (stop(), setTimeout(free, 0), null);
      return slice;
    },
  };
}

/**
 * The default `openCursor` of a layer: reads the artifact in ranges, opens it in the evaluator and walks its Tier 0
 * stream over the manifest's source extent.
 */
export async function openTier0Cursor(handle: PVecHandle, evaluator: Evaluator, source: PVecSource, signal?: AbortSignal): Promise<BlockCursor> {
  const bytes = new Uint8Array(handle.artifactLength);
  for (let at = 0; at < bytes.length; at += CHUNK) {
    bytes.set(await source.readRange(at, Math.min(CHUNK, bytes.length - at), signal ? { signal } : {}), at);
  }
  const b = handle.manifest.sourceBounds;
  return tier0CursorOver(evaluator, bytes, [b.minX, b.minY, b.maxX, b.maxY]);
}
