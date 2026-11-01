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
// A window with more entities than this is split in four before it is tessellated, so one `next` costs the evaluator a small, even amount.
const STEP_ENTITIES = 512;
const MAX_DEPTH = 12;
// What one `next` call spends before it hands back what it has.
const CALL_MS = 2;
// Stored previews are copied out this many to a step.
const PREVIEW_STEP = 256;

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
/** One unit of work: a window to answer (`top`: also read its stored previews first) or the rest of a stored preview stream. */
type Job = { box: Box; depth: number; top: boolean } | { stream: number; at: number };

/**
 * A cursor over the evaluator's Tier 0 stream of a file held in memory, in steps that each cost the evaluator a few
 * hundred entities, so that the decoder's slices stay short. Previews the file stores (codes 1 and 2) come from the stream
 * with their declared error; everything else, which is every entity of a file with no spatial directory, is the
 * evaluator's tessellation at one pixel of a 1920 pixel view of the whole drawing. A window holding more than a
 * few hundred entities is split in four first (an entity on a split line is answered once). All of it is display fidelity,
 * so every entity is a `preview`, with its error in pixels of that view. `window` is the source extent as
 * `[minX, minY, maxX, maxY]`. The cursor owns the file handle until it is drained; call `close` to give it back early.
 */
export function tier0CursorOver(evaluator: Evaluator, bytes: Uint8Array, window: readonly [number, number, number, number]): BlockCursor & { close(): void } {
  const rt = bindPacked(evaluator);
  const file = rt.open(bytes);
  if (file < 0) throw new PVecError("load_failed", `the evaluator refused the file (code ${file})`);
  const px = Math.max(window[2] - window[0], window[3] - window[1], 1e-9) / FULL_VIEW_PX;
  const chain = [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1e9, px];
  const jobs: Job[] = [];
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    for (const j of jobs) if ("stream" in j) rt.release(j.stream);
    jobs.length = 0;
    rt.release(file);
  };
  // The windows to walk: every leaf box of the directory, then the advanced curves' own box, or the extent when the file has no directory.
  const tops: Box[] = [];
  if (rt.directoryStat(file, 0) === 1) {
    const q = rt.directoryQuery(file, ...window);
    if (typeof q !== "number") {
      for (let i = 0; i < q.cells.length; i++) tops.push([q.boxes[4 * i]!, q.boxes[4 * i + 1]!, q.boxes[4 * i + 2]!, q.boxes[4 * i + 3]!]);
      rt.release(q.handle);
    }
    const adv = [4, 5, 6, 7].map((n) => rt.directoryBound(file, n));
    if (adv.every(Number.isFinite)) tops.push(adv as unknown as Box);
  } else {
    tops.push([...window]);
  }
  for (const box of tops.reverse()) jobs.push({ box, depth: 0, top: true });
  const hasDirectory = rt.directoryStat(file, 0) === 1;
  const seen = new Set<number>();
  const pending: RawEntity[] = [];
  let at = 0;
  const entity = (id: number, points: number[], declaredErrorPx: number): RawEntity => ({
    entityId: String(id),
    kind: "preview",
    geometry: { type: "polyline", points },
    bounds: boundsOf(points),
    declaredErrorPx,
  });
  const step = (): void => {
    const job = jobs.pop()!;
    if ("stream" in job) {
      const v = rt.tier0Views(job.stream);
      const end = Math.min(v.ids.length, job.at + PREVIEW_STEP);
      for (let i = job.at; i < end; i++) {
        const id = v.ids[i]!, code = v.codes[i]!;
        if (seen.has(id) || (code !== 1 && code !== 2)) continue;
        const points = Array.from(v.vertices.subarray(2 * v.offsets[i]!, 2 * v.offsets[i + 1]!));
        if (points.length >= 4) (seen.add(id), pending.push(entity(id, points, v.errors[i]! / px)));
      }
      if (end < v.ids.length) jobs.push({ stream: job.stream, at: end });
      else rt.release(job.stream);
      return;
    }
    const w = job.box;
    if (job.top && hasDirectory) {
      const t = rt.tier0Viewport(file, ...w);
      // The remaining windows go below the stream on the stack, which is read first.
      if (t >= 0) (jobs.push({ box: w, depth: job.depth, top: false }), jobs.push({ stream: t, at: 0 }));
      else jobs.push({ box: w, depth: job.depth, top: false });
      return;
    }
    const batch = rt.queryViewport(file, ...w, MAX_ENTITIES);
    if (batch < 0) return;
    try {
      if (rt.batchLength(batch) > STEP_ENTITIES && job.depth < MAX_DEPTH && w[2] > w[0] && w[3] > w[1]) {
        const mx = (w[0] + w[2]) / 2, my = (w[1] + w[3]) / 2;
        for (const b of [[mx, my, w[2], w[3]], [w[0], my, mx, w[3]], [mx, w[1], w[2], my], [w[0], w[1], mx, my]] as Box[]) jobs.push({ box: b, depth: job.depth + 1, top: false });
        return;
      }
      const tess = rt.tessellate(batch, chain, MAX_SEGMENTS, "f64");
      if (tess < 0) return;
      try {
        const v = rt.views(tess);
        for (let i = 0; i < v.entityIds.length; i++) {
          const id = v.entityIds[i]!;
          if (seen.has(id)) continue;
          const points = Array.from(v.vertices.subarray(2 * v.offsets[i]!, 2 * v.offsets[i + 1]!));
          if (points.length >= 4) (seen.add(id), pending.push(entity(id, points, 1)));
        }
      } finally {
        rt.release(tess);
      }
    } finally {
      rt.release(batch);
    }
  };
  return {
    close,
    next(max: number): RawEntity[] | null {
      // Windows overlap, so a run of steps can answer only entities already seen. A call gives up its turn after a couple of milliseconds
      // with whatever it has, which may be nothing: an empty batch is not the end, `null` is.
      const start = performance.now();
      while (pending.length - at < max && jobs.length && performance.now() - start < CALL_MS) step();
      if (at >= pending.length) return jobs.length ? [] : (close(), null);
      const slice = pending.slice(at, at + max);
      at += slice.length;
      if (at > 4096) (pending.splice(0, at), (at = 0));
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
