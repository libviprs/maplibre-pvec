import { DEFAULTS } from '../config/defaults';

/** Source to render-space transform. Error is always measured on its output. */
export interface ScreenPipeline { toScreen(x: number, y: number): [number, number] }

export type CurveRef =
  | { kind: 'arc'; cx: number; cy: number; r: number; a0: number; a1: number; trim?: [number, number] }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rot: number; t0: number; t1: number; trim?: [number, number] };

export interface PreviewResult {
  /** Source-space vertices (x,y pairs). */
  positions: Float64Array;
  declaredErrorPx: number;
  generation: 0;
  conformance: 'display-fidelity';
  /** True when the iteration cap bound and declaredErrorPx is above the budget. */
  flaggedForRefinement: boolean;
}

function domain(c: CurveRef): [number, number] {
  const [lo, hi] = c.kind === 'arc' ? [c.a0, c.a1] : [c.t0, c.t1];
  const [f0, f1] = c.trim ?? [0, 1];
  return [lo + (hi - lo) * f0, lo + (hi - lo) * f1];
}

function evalCurve(c: CurveRef, t: number): [number, number] {
  if (c.kind === 'arc') return [c.cx + c.r * Math.cos(t), c.cy + c.r * Math.sin(t)];
  const x = c.rx * Math.cos(t), y = c.ry * Math.sin(t), co = Math.cos(c.rot), si = Math.sin(c.rot);
  return [c.cx + co * x - si * y, c.cy + si * x + co * y];
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const SAMPLES_PER_SEGMENT = 8;
const MARGIN = 1.02;

/**
 * Uniform parameter subdivision, doubled until the error measured on the transformed curve
 * is within budget or the iteration cap binds. The declared error is the measured maximum
 * chord deviation (with a small margin), so it stays honest after any pipeline.
 */
export function previewTessellate(c: CurveRef, pipe: ScreenPipeline, budgetPx: number = DEFAULTS.previewBudgetPx, o: { maxIterations?: number } = {}): PreviewResult {
  const [t0, t1] = domain(c);
  const cap = o.maxIterations ?? DEFAULTS.previewMaxIterations;
  let n = 4, declared = Infinity;
  for (let it = 0; ; it++) {
    declared = 0;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = pipe.toScreen(...evalCurve(c, t0 + ((t1 - t0) * i) / n));
      const [bx, by] = pipe.toScreen(...evalCurve(c, t0 + ((t1 - t0) * (i + 1)) / n));
      for (let k = 1; k <= SAMPLES_PER_SEGMENT; k++) {
        const [px, py] = pipe.toScreen(...evalCurve(c, t0 + ((t1 - t0) * (i + k / (SAMPLES_PER_SEGMENT + 1))) / n));
        declared = Math.max(declared, segDist(px, py, ax, ay, bx, by));
      }
    }
    declared *= MARGIN;
    if (declared <= budgetPx || it >= cap) break;
    n *= 2;
  }
  const positions = new Float64Array((n + 1) * 2);
  for (let i = 0; i <= n; i++) {
    const [x, y] = evalCurve(c, i === n ? t1 : t0 + ((t1 - t0) * i) / n);
    positions[2 * i] = x; positions[2 * i + 1] = y;
  }
  return { positions, declaredErrorPx: declared, generation: 0, conformance: 'display-fidelity', flaggedForRefinement: declared > budgetPx };
}

/** Independent check: max distance from `samples` analytic points to the transformed polyline. */
export function measureDeviation(c: CurveRef, positions: ArrayLike<number>, pipe: ScreenPipeline, samples: number): number {
  const [t0, t1] = domain(c);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i + 1 < positions.length; i += 2) pts.push(pipe.toScreen(positions[i]!, positions[i + 1]!));
  let worst = 0;
  for (let s = 0; s <= samples; s++) {
    const [px, py] = pipe.toScreen(...evalCurve(c, t0 + ((t1 - t0) * s) / samples));
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, segDist(px, py, pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1]));
    worst = Math.max(worst, best);
  }
  return worst;
}
