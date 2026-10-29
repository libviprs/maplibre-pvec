import type { SourceAabb } from '../transform/inverse';
import { type TransformPipeline, sourceToDevicePx } from '../transform/screen_error';

/**
 * A cullable entity as the PVec evaluator describes it. `breakParams` are the analytic extrema
 * (axis extrema of arcs and ellipses inside the trimmed range, joins of composite curves): between
 * consecutive breaks the curve is monotone in x and y, so each sub-interval lies inside the
 * source box spanned by its own two endpoints.
 */
export interface CullableEntity {
  readonly domain: readonly [number, number];
  point(t: number): [number, number];
  readonly breakParams: readonly number[];
  /** Full stroke width in CSS px. */
  readonly strokeWidthPx: number;
}

export interface ScreenAabb {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface CullOptions {
  /** Uniform sub-boxes per monotone piece. Default 8. */
  readonly subdivisionsPerPiece?: number;
  /** Antialias feather in CSS px (M5.4). Default 1. */
  readonly featherPx?: number;
}

const EDGE_SAMPLES = 4;
/** Safety factor on the measured chord deviation of transformed box edges. */
const NONLINEARITY_SAFETY = 2;

/**
 * Conservative device-px bounds of the entity. Returns null when any part of it cannot be
 * projected (behind the camera plane): callers must treat null as never culled.
 */
export function conservativeScreenBounds(
  entity: CullableEntity,
  pipeline: TransformPipeline,
  opts: CullOptions = {},
): ScreenAabb | null {
  const subs = Math.max(1, opts.subdivisionsPerPiece ?? 8);
  const [d0, d1] = entity.domain;
  const breaks = [d0, ...entity.breakParams.filter((t) => t > d0 && t < d1).sort((a, b) => a - b), d1];
  const dpr = pipeline.camera.devicePixelRatio;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let nonlin = 0;

  for (let i = 0; i + 1 < breaks.length; i++) {
    for (let s = 0; s < subs; s++) {
      const ta = breaks[i]! + ((breaks[i + 1]! - breaks[i]!) * s) / subs;
      const tb = breaks[i]! + ((breaks[i + 1]! - breaks[i]!) * (s + 1)) / subs;
      const [ax, ay] = entity.point(ta), [bx, by] = entity.point(tb);
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
      const edges: [number, number, number, number][] = [
        [x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0],
      ];
      for (const [px, py, qx, qy] of edges) {
        let prev: [number, number] | null = null;
        for (let k = 0; k <= EDGE_SAMPLES; k++) {
          const f = k / EDGE_SAMPLES;
          const sp = sourceToDevicePx(pipeline, px + (qx - px) * f, py + (qy - py) * f);
          if (!Number.isFinite(sp[0] + sp[1])) return null;
          if (sp[0] < minX) minX = sp[0];
          if (sp[0] > maxX) maxX = sp[0];
          if (sp[1] < minY) minY = sp[1];
          if (sp[1] > maxY) maxY = sp[1];
          if (prev) {
            const f2 = (k - 0.5) / EDGE_SAMPLES;
            const mid = sourceToDevicePx(pipeline, px + (qx - px) * f2, py + (qy - py) * f2);
            const dev = Math.hypot(mid[0] - (prev[0] + sp[0]) / 2, mid[1] - (prev[1] + sp[1]) / 2);
            if (!Number.isFinite(dev)) return null;
            if (dev > nonlin) nonlin = dev;
          }
          prev = sp;
        }
      }
    }
  }
  const pad = NONLINEARITY_SAFETY * nonlin + ((entity.strokeWidthPx / 2) + (opts.featherPx ?? 1)) * dpr;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/** Entity-level test against the viewport in device px. */
export function isEntityVisible(
  entity: CullableEntity,
  pipeline: TransformPipeline,
  opts: CullOptions = {},
): boolean {
  const b = conservativeScreenBounds(entity, pipeline, opts);
  if (!b) return true;
  const { width, height, devicePixelRatio: dpr } = pipeline.camera;
  return b.maxX >= 0 && b.minX <= width * dpr && b.maxY >= 0 && b.minY <= height * dpr;
}

export interface BlockBounds {
  readonly id: number;
  readonly aabb: SourceAabb;
}

/** Block-level culling against the source-space viewport query from M4.3. */
export function visibleBlocks(blocks: readonly BlockBounds[], query: SourceAabb): BlockBounds[] {
  return blocks.filter(
    (b) =>
      b.aabb.maxX >= query.minX && b.aabb.minX <= query.maxX &&
      b.aabb.maxY >= query.minY && b.aabb.minY <= query.maxY,
  );
}
