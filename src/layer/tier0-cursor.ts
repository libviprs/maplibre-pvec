import type { BlockCursor, RawEntity } from "../decode/tier0";
import type { PVecHandle } from "../source/bootstrap";
import { PVecError } from "../source/errors";
import type { PVecSource } from "../source/PVecSource";
import type { Evaluator } from "../wasm/loader";
import { bindPacked } from "../wasm/packed";

// The evaluator opens a whole file from memory (its range-callback open waits on pvec's `http` feature), so
// the artifact is read in ranges and handed over in one piece.
const CHUNK = 4 << 20;
const MAX_ENTITIES = 2 ** 31 - 1;
// Identity transforms, pixel ratio 1: the screen error and the world error are then the same number, in source units.
const ASKED_ERROR = 0.01;
const CHAIN = [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1e9, ASKED_ERROR];

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

/**
 * A cursor over the evaluator's Tier 0 stream of a file held in memory, one directory leaf at a time, so that
 * each `next` call costs the evaluator a few cells and the decoder's slices stay short. Previews the file stores
 * (codes 1 and 2) come from the stream with their declared error; everything else, which is every entity of a file
 * with no spatial directory, is the evaluator's tessellation at the asked error. All of it is display fidelity,
 * so every entity is a `preview`. `window` is the source extent as `[minX, minY, maxX, maxY]`. The cursor owns
 * the file handle until it is drained; call `close` to give it back early.
 */
export function tier0CursorOver(evaluator: Evaluator, bytes: Uint8Array, window: readonly [number, number, number, number]): BlockCursor & { close(): void } {
  const rt = bindPacked(evaluator);
  const file = rt.open(bytes);
  if (file < 0) throw new PVecError("load_failed", `the evaluator refused the file (code ${file})`);
  let open = true;
  const close = (): void => {
    if (open) (open = false, rt.release(file));
  };
  // The windows to walk: every leaf box of the directory, then the advanced curves' own box, or the extent when the file has no directory.
  const windows: [number, number, number, number][] = [];
  if (rt.directoryStat(file, 0) === 1) {
    const q = rt.directoryQuery(file, ...window);
    if (typeof q !== "number") {
      for (let i = 0; i < q.cells.length; i++) windows.push([q.boxes[4 * i]!, q.boxes[4 * i + 1]!, q.boxes[4 * i + 2]!, q.boxes[4 * i + 3]!]);
      rt.release(q.handle);
    }
    const adv = [4, 5, 6, 7].map((n) => rt.directoryBound(file, n));
    if (adv.every(Number.isFinite)) windows.push(adv as [number, number, number, number]);
  } else {
    windows.push([...window]);
  }
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
  const walk = (w: readonly [number, number, number, number]): void => {
    const held: number[] = [];
    try {
      if (rt.directoryStat(file, 0) === 1) {
        const t = rt.tier0Viewport(file, ...w);
        if (t >= 0) {
          held.push(t);
          const v = rt.tier0Views(t);
          for (let i = 0; i < v.ids.length; i++) {
            const id = v.ids[i]!, code = v.codes[i]!;
            if (seen.has(id) || (code !== 1 && code !== 2)) continue;
            const points = Array.from(v.vertices.subarray(2 * v.offsets[i]!, 2 * v.offsets[i + 1]!));
            if (points.length >= 4) (seen.add(id), pending.push(entity(id, points, v.errors[i]!)));
          }
        }
      }
      const batch = rt.queryViewport(file, ...w, MAX_ENTITIES);
      if (batch < 0) return;
      held.push(batch);
      const tess = rt.tessellate(batch, CHAIN, MAX_ENTITIES, "f64");
      if (tess < 0) return;
      held.push(tess);
      const v = rt.views(tess);
      for (let i = 0; i < v.entityIds.length; i++) {
        const id = v.entityIds[i]!;
        if (seen.has(id)) continue;
        const points = Array.from(v.vertices.subarray(2 * v.offsets[i]!, 2 * v.offsets[i + 1]!));
        if (points.length >= 4) (seen.add(id), pending.push(entity(id, points, ASKED_ERROR)));
      }
    } finally {
      for (const h of held.reverse()) rt.release(h);
    }
  };
  let cell = 0;
  return {
    close,
    next(max: number): RawEntity[] | null {
      while (pending.length - at < max && cell < windows.length) walk(windows[cell++]!);
      if (at >= pending.length) return (close(), null);
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
