import type { CurveEvaluator, CurveFamily } from '../../../src/workers/evaluator';
import type { CurveRef } from '../../../src/transform/screen_error';
import { rng } from './rng';

/**
 * Test double for the PVec WASM evaluator. It evaluates cubic Beziers (4 control points, 8 packed
 * f64) so the surrounding machinery has something real to move. The real evaluator is an
 * unreleased artifact (docs/deferred.md); this lives under tests/ because curve mathematics is
 * not allowed in src/.
 */
export function cubicAt(c: ArrayLike<number>, t: number): [number, number] {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return [a * c[0]! + b * c[2]! + d * c[4]! + e * c[6]!, a * c[1]! + b * c[3]! + d * c[5]! + e * c[7]!];
}

export class DoubleEvaluator implements CurveEvaluator {
  readonly capabilities: ReadonlySet<CurveFamily>;
  calls = 0;
  maxBatch = 0;
  evaluations = 0;
  constructor(caps: CurveFamily[] = ['bezier']) { this.capabilities = new Set(caps); }
  evaluateBatch(_family: CurveFamily, control: Float64Array, params: Float64Array, out: Float64Array): void {
    this.calls++;
    this.evaluations += params.length;
    if (params.length > this.maxBatch) this.maxBatch = params.length;
    for (let i = 0; i < params.length; i++) {
      const [x, y] = cubicAt(control, params[i]!);
      out[2 * i] = x;
      out[2 * i + 1] = y;
    }
  }
}

export interface SplineEntity {
  id: number;
  control: Float64Array;
  curve: CurveRef;
  /** Rough size in source units, for ordering tests. */
  size: number;
}

/** A spline-heavy fixture: wiggly cubics of mixed size scattered around the origin (source units: metres). */
export function splineFixture(n: number, seed = 7, spread = 400): SplineEntity[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, id) => {
    const size = 2 + r() * 30;
    const ox = (r() - 0.5) * spread, oy = (r() - 0.5) * spread;
    const control = new Float64Array(8);
    for (let k = 0; k < 4; k++) {
      control[2 * k] = ox + (k / 3) * size + (r() - 0.5) * size * 0.6;
      control[2 * k + 1] = oy + (r() - 0.5) * size;
    }
    return { id, control, size, curve: { domain: [0, 1], point: (t: number) => cubicAt(control, t) } };
  });
}

/** Distance from p to the segment a-b. */
export function distSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Worst distance (source units) of the f64 ground-truth curve from a tessellation, sampled at `samples` parameters. */
export function measureSource(control: ArrayLike<number>, params: ArrayLike<number>, positions: ArrayLike<number>, samples = 1000): number {
  let worst = 0, seg = 0;
  const n = params.length;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    while (seg < n - 2 && t > params[seg + 1]!) seg++;
    const [x, y] = cubicAt(control, t);
    const e = distSeg(x, y, positions[2 * seg]!, positions[2 * seg + 1]!, positions[2 * seg + 2]!, positions[2 * seg + 3]!);
    if (e > worst) worst = e;
  }
  return worst;
}
