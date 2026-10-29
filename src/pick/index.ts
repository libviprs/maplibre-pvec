import { DEFAULTS } from '../config/defaults';

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
export interface LngLat { lng: number; lat: number }
export interface SourcePoint { x: number; y: number }

/** The inverse half of the full transform pipeline (M4.3). */
export interface PickPipeline {
  lngLatToSource(l: LngLat): SourcePoint;
  /** Source units covered by one device pixel at this location. */
  sourceUnitsPerDevicePx(l: LngLat): number;
}
export interface Candidate { entityId: string; entityType: string }
export interface SpatialIndexView {
  /** Entities whose conservative bounds intersect `b`. */
  query(b: Bounds): Candidate[];
  /** Are all blocks covering `b` loaded? */
  isLoaded(b: Bounds): boolean;
}
/** Analytic evaluator (WASM). Never reads display buffers. */
export interface AnalyticEvaluator {
  distance(entityId: string, p: SourcePoint): number;
  intersects(entityId: string, region: Bounds | SourcePoint[]): boolean;
}
export interface PickContext {
  pipeline: PickPipeline;
  index: SpatialIndexView;
  evaluator: AnalyticEvaluator;
  /** Generation currently displayed for the entity (0 = preview, 1+ = refined). */
  generation(entityId: string): number;
  /** Safety cap on the candidate search radius in device px. */
  maxCandidateRadiusPx: number;
}
export interface PickHit { entityId: string; entityType: string; distancePx: number; generation: number }
export interface PickResult { hits: PickHit[]; /** false when part of the searched region is not loaded yet. */ complete: boolean }

export function pickPoint(ctx: PickContext, at: LngLat, o: { radiusPx?: number } = {}): PickResult {
  const r = Math.min(o.radiusPx ?? DEFAULTS.pickRadiusPx, ctx.maxCandidateRadiusPx);
  const upx = ctx.pipeline.sourceUnitsPerDevicePx(at);
  const c = ctx.pipeline.lngLatToSource(at);
  const rs = r * upx;
  const box = { minX: c.x - rs, minY: c.y - rs, maxX: c.x + rs, maxY: c.y + rs };
  const hits: PickHit[] = [];
  for (const cand of ctx.index.query(box)) {
    const d = ctx.evaluator.distance(cand.entityId, c) / upx;
    if (d <= r) hits.push({ entityId: cand.entityId, entityType: cand.entityType, distancePx: d, generation: ctx.generation(cand.entityId) });
  }
  hits.sort((a, b) => a.distancePx - b.distancePx);
  return { hits, complete: ctx.index.isLoaded(box) };
}

export function nearestEntity(ctx: PickContext, at: LngLat, o: { maxRadiusPx?: number } = {}): { hit?: PickHit; complete: boolean } {
  const res = pickPoint(ctx, at, { radiusPx: o.maxRadiusPx ?? DEFAULTS.pickRadiusPx });
  return { hit: res.hits[0], complete: res.complete };
}

/** Entities whose analytic geometry touches the region. Set-exact, not a bounds superset. */
export function queryRegion(ctx: PickContext, region: Bounds | SourcePoint[]): PickResult {
  const hits: PickHit[] = [];
  const box = Array.isArray(region)
    ? { minX: Math.min(...region.map((p) => p.x)), minY: Math.min(...region.map((p) => p.y)), maxX: Math.max(...region.map((p) => p.x)), maxY: Math.max(...region.map((p) => p.y)) }
    : region;
  for (const cand of ctx.index.query(box)) {
    if (ctx.evaluator.intersects(cand.entityId, region)) hits.push({ entityId: cand.entityId, entityType: cand.entityType, distancePx: 0, generation: ctx.generation(cand.entityId) });
  }
  return { hits, complete: ctx.index.isLoaded(box) };
}
