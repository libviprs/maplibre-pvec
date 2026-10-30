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
 * The default `openCursor` of a layer: the evaluator's own Tier 0 stream for the whole source extent. Previews
 * the file stores (codes 1 and 2) come from the stream with their declared error; everything else, which is every
 * entity of a file with no spatial directory, is the evaluator's tessellation at the asked error. All of it is
 * display fidelity, so every entity is a `preview`.
 */
export async function openTier0Cursor(handle: PVecHandle, evaluator: Evaluator, source: PVecSource, signal?: AbortSignal): Promise<BlockCursor> {
  const bytes = new Uint8Array(handle.artifactLength);
  for (let at = 0; at < bytes.length; at += CHUNK) {
    bytes.set(await source.readRange(at, Math.min(CHUNK, bytes.length - at), signal ? { signal } : {}), at);
  }
  const rt = bindPacked(evaluator);
  const held: number[] = [];
  const file = rt.open(bytes);
  if (file < 0) throw new PVecError("load_failed", `the evaluator refused the file (code ${file})`);
  held.push(file);
  try {
    const { minX, minY, maxX, maxY } = handle.manifest.sourceBounds;
    const out = new Map<number, RawEntity>();
    const entity = (id: number, points: number[], declaredErrorPx: number): RawEntity => ({
      entityId: String(id),
      kind: "preview",
      geometry: { type: "polyline", points },
      bounds: boundsOf(points),
      declaredErrorPx,
    });
    if (rt.directoryStat(file, 0) === 1) {
      const t = rt.tier0Viewport(file, minX, minY, maxX, maxY);
      if (t >= 0) {
        held.push(t);
        const v = rt.tier0Views(t);
        for (let i = 0; i < v.ids.length; i++) {
          const code = v.codes[i]!;
          if (code !== 1 && code !== 2) continue;
          const points = Array.from(v.vertices.subarray(2 * v.offsets[i]!, 2 * v.offsets[i + 1]!));
          if (points.length >= 4) out.set(v.ids[i]!, entity(v.ids[i]!, points, v.errors[i]!));
        }
      }
    }
    const batch = rt.queryViewport(file, minX, minY, maxX, maxY, MAX_ENTITIES);
    if (batch >= 0) {
      held.push(batch);
      const tess = rt.tessellate(batch, CHAIN, MAX_ENTITIES, "f64");
      if (tess >= 0) {
        held.push(tess);
        const v = rt.views(tess);
        for (let i = 0; i < v.entityIds.length; i++) {
          const id = v.entityIds[i]!;
          if (out.has(id)) continue;
          const points = Array.from(v.vertices.subarray(2 * v.offsets[i]!, 2 * v.offsets[i + 1]!));
          if (points.length >= 4) out.set(id, entity(id, points, ASKED_ERROR));
        }
      }
    }
    const all = [...out.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
    let at = 0;
    return {
      next(max: number): RawEntity[] | null {
        if (at >= all.length) return null;
        const slice = all.slice(at, at + max);
        at += slice.length;
        return slice;
      },
    };
  } finally {
    for (const h of held.reverse()) rt.release(h);
  }
}
