import type { CurveFamily } from '../workers/evaluator';

export class CurveDataError extends Error {}

/** One deferred curve as decoded from its analytic block. */
export interface DeferredCurve {
  family: CurveFamily;
  degree: number;
  /** Interleaved x, y control points. */
  points: readonly number[];
  knots?: readonly number[];
  weights?: readonly number[];
  domain: readonly [number, number];
  trims: readonly (readonly [number, number])[];
}

export interface PackedCurves {
  count: number;
  /** Packed control data of every curve, back to back. Header per curve: degree, nPoints, nKnots, nWeights, nTrims, domain0, domain1. */
  data: Float64Array;
  /** Start of each curve in `data`, in f64 elements, plus the total as the last entry. */
  offsets: Uint32Array;
}

const HEADER = 7;

function validate(c: DeferredCurve, at: number): void {
  const fail = (m: string): never => { throw new CurveDataError(`curve ${at}: ${m}`); };
  if (!Number.isInteger(c.degree) || c.degree < 1) fail('degree must be a positive integer');
  if (c.points.length % 2 !== 0 || c.points.length < 4) fail('control points must be x, y pairs, at least two');
  for (const v of c.points) if (!Number.isFinite(v)) fail('non-finite control point');
  if (!(c.domain[0] < c.domain[1]) || !Number.isFinite(c.domain[0]) || !Number.isFinite(c.domain[1])) fail('invalid parameter domain');
  const n = c.points.length / 2;
  if (c.knots) {
    if (c.knots.length !== n + c.degree + 1) fail(`knot count ${c.knots.length} does not match ${n} points of degree ${c.degree}`);
    for (let i = 0; i < c.knots.length; i++) {
      if (!Number.isFinite(c.knots[i]!)) fail('non-finite knot');
      if (i > 0 && c.knots[i]! < c.knots[i - 1]!) fail('knots must be non-decreasing');
    }
  }
  if (c.weights) {
    if (c.weights.length !== n) fail('one weight per control point is required');
    for (const w of c.weights) if (!Number.isFinite(w) || w <= 0) fail('weights must be finite and positive; they are rejected, never clamped');
  }
  for (const [a, b] of c.trims) if (!(a < b) || a < c.domain[0] || b > c.domain[1]) fail('trim interval outside the domain');
}

/** Validate and pack a batch of curves for one evaluator call per chunk. */
export function packCurves(curves: readonly DeferredCurve[]): PackedCurves {
  const sizes = curves.map((c, i) => {
    validate(c, i);
    return HEADER + c.points.length + (c.knots?.length ?? 0) + (c.weights?.length ?? 0) + 2 * c.trims.length;
  });
  const offsets = new Uint32Array(curves.length + 1);
  sizes.forEach((s, i) => { offsets[i + 1] = offsets[i]! + s; });
  const data = new Float64Array(offsets[curves.length]!);
  curves.forEach((c, i) => {
    let o = offsets[i]!;
    data.set([c.degree, c.points.length / 2, c.knots?.length ?? 0, c.weights?.length ?? 0, c.trims.length, c.domain[0], c.domain[1]], o);
    o += HEADER;
    data.set(c.points, o); o += c.points.length;
    if (c.knots) { data.set(c.knots, o); o += c.knots.length; }
    if (c.weights) { data.set(c.weights, o); o += c.weights.length; }
    for (const [a, b] of c.trims) { data[o++] = a; data[o++] = b; }
  });
  return { count: curves.length, data, offsets };
}

/** Group curve indices into batches whose summed length stays near `limit` (a curve is never split here). */
export function splitForBatches(lengths: readonly number[], limit: number): number[][] {
  const out: number[][] = [];
  let cur: number[] = [], sum = 0;
  lengths.forEach((len, i) => {
    if (cur.length && sum + len > limit) { out.push(cur); cur = []; sum = 0; }
    cur.push(i); sum += len;
  });
  if (cur.length) out.push(cur);
  return out;
}
