import type { GeoTransform } from './georeference';
import {
  type Camera,
  type LngLatBounds,
  type ProjectionAdapter,
  MIN_EDGE_SAMPLES,
  unprojectToGround,
} from './projection';

export interface SourceAabb {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface InverseQueryOptions {
  /** Extra margin in source units: one spatial chunk, so sampling cannot cause a miss. Default 0. */
  readonly chunkMargin?: number;
  /**
   * Horizon clamp: the far plane is limited to this many multiples of max(width, height) of
   * ground distance (mercator px at the camera zoom). Default 1.5.
   */
  readonly horizonScreens?: number;
  /** Multiplier on projection.maxErrorInflation. 1 is the contract; the tests mutate it to 0. */
  readonly inflationScale?: number;
  /** Stop doubling when the sampled bounds grow by no more than this fraction. Default 0.005. */
  readonly growthTolerance?: number;
  readonly maxSamplesPerEdge?: number;
}

export const DEFAULT_HORIZON_SCREENS = 1.5;

/** Boundary samples (16 per edge, adaptively doubled), already inverted to lng/lat. */
function sampleBoundary(camera: Camera, n: number, maxForward: number): [number, number][] {
  const w = camera.width, h = camera.height;
  const out: [number, number][] = [];
  const push = (x: number, y: number) => {
    const hit = unprojectToGround(x, y, camera, maxForward);
    if (hit) out.push(hit.lngLat);
  };
  for (let i = 0; i < n; i++) {
    const t = i / n;
    push(t * w, 0);
    push(w, t * h);
    push(w - t * w, h);
    push(0, h - t * h);
  }
  return out;
}

function lngLatBounds(pts: readonly [number, number][]): LngLatBounds {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lng, lat] of pts) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, south, east, north };
}

function sampleUntilStable(camera: Camera, opts: InverseQueryOptions, toSource: GeoTransform['inverse']) {
  const maxForward = (opts.horizonScreens ?? DEFAULT_HORIZON_SCREENS) * Math.max(camera.width, camera.height);
  const tol = opts.growthTolerance ?? 0.005;
  const maxN = opts.maxSamplesPerEdge ?? 256;
  let n = MIN_EDGE_SAMPLES;
  let pts = sampleBoundary(camera, n, maxForward);
  let area = sourceArea(pts, toSource);
  while (n < maxN) {
    const next = sampleBoundary(camera, n * 2, maxForward);
    const nextArea = sourceArea(next, toSource);
    n *= 2;
    pts = next;
    const grew = nextArea > area * (1 + tol);
    area = Math.max(area, nextArea);
    if (!grew) break;
  }
  return pts;
}

function sourceArea(pts: readonly [number, number][], toSource: GeoTransform['inverse']): number {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [lng, lat] of pts) {
    const [x, y] = toSource(lng, lat);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return (x1 - x0) * (y1 - y0);
}

/**
 * Conservative source-space AABB of the viewport preimage: boundary samples, inverted through
 * the CRS and calibration, grown by the projection's error inflation and a chunk margin.
 */
export function viewportToSourceBounds(
  camera: Camera,
  transform: GeoTransform,
  projection: ProjectionAdapter,
  opts: InverseQueryOptions = {},
): SourceAabb {
  const pts = sampleUntilStable(camera, opts, transform.inverse);
  const m = projection.maxErrorInflation(lngLatBounds(pts), camera) * (opts.inflationScale ?? 1);
  const cm = opts.chunkMargin ?? 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  // Each sample is grown by +-m degrees (lng/lat corner shifts), then mapped to source space.
  for (const [lng, lat] of pts) {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const [x, y] = transform.inverse(lng + sx * m, lat + sy * m);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { minX: x0 - cm, minY: y0 - cm, maxX: x1 + cm, maxY: y1 + cm };
}

/**
 * Tighter convex polygon (counter-clockwise, `[x0, y0, x1, y1, ...]`) around the same preimage,
 * with the same inflation applied as lng/lat corner shifts and the chunk margin as source shifts.
 */
export function viewportToSourceRings(
  camera: Camera,
  transform: GeoTransform,
  projection: ProjectionAdapter,
  opts: InverseQueryOptions = {},
): Float64Array {
  const pts = sampleUntilStable(camera, opts, transform.inverse);
  const m = projection.maxErrorInflation(lngLatBounds(pts), camera) * (opts.inflationScale ?? 1);
  const cm = opts.chunkMargin ?? 0;
  const all: [number, number][] = [];
  for (const [lng, lat] of pts) {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const [x, y] = transform.inverse(lng + sx * m, lat + sy * m);
        if (cm === 0) all.push([x, y]);
        else for (const ex of [-1, 1]) for (const ey of [-1, 1]) all.push([x + ex * cm, y + ey * cm]);
      }
    }
  }
  const hull = convexHull(all);
  const out = new Float64Array(hull.length * 2);
  hull.forEach(([x, y], i) => {
    out[2 * i] = x;
    out[2 * i + 1] = y;
  });
  return out;
}

/** Andrew's monotone chain, counter-clockwise. */
export function convexHull(points: readonly [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
