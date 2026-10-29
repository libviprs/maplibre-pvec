import { MAX_SUBDIVISION_DEPTH } from '../config/defaults';

/**
 * The curve families the PVec evaluator handles. All curve mathematics (basis functions, knot
 * handling, derivatives) lives behind CurveEvaluator, which the shared Rust evaluator compiled to
 * WASM implements. Nothing in this repository evaluates ISO curve mathematics in TypeScript.
 */
export type CurveFamily = 'bezier' | 'bspline' | 'nurbs' | 'composite' | 'trimmed';

/** Parameters per evaluator call. Batches of this size amortise the call boundary (spike 03). */
export const EVAL_BATCH = 4096;

export interface CurveEvaluator {
  readonly capabilities: ReadonlySet<CurveFamily>;
  /** Evaluate `params.length` points. `out` receives interleaved x, y, so out.length >= 2 * params.length. */
  evaluateBatch(family: CurveFamily, control: Float64Array, params: Float64Array, out: Float64Array): void;
}

export interface RefineJobInput {
  family: CurveFamily;
  /** Packed control data for one curve (see decode/advanced.ts). */
  control: Float64Array;
  t0: number;
  t1: number;
  /** Chord tolerance in source units. */
  toleranceUnits: number;
}

export interface RefinePiece {
  /** Ascending parameters, first t0 and last t1. */
  params: Float64Array;
  /** Interleaved x, y of the curve at `params`, source units. */
  positions: Float64Array;
  evaluations: number;
  batches: number;
}

/** Interior parameters sampled per interval to measure chord deviation. */
const SAMPLES = 7;
const FINITE_DEPTH_LIMIT = MAX_SUBDIVISION_DEPTH;

interface Interval { t0: number; t1: number; x0: number; y0: number; x1: number; y1: number; depth: number }

function chordDeviation(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/**
 * Adaptive tessellation of [t0, t1] driven in packed evaluator batches. It yields the number of
 * evaluations after every batch, which is where a caller may stop (cancellation) or hand the
 * thread back. Interval bookkeeping only compares points the evaluator returned.
 */
export function* refineSteps(ev: CurveEvaluator, job: RefineJobInput): Generator<number, RefinePiece, void> {
  let evaluations = 0, batches = 0;
  const perBatch = Math.floor(EVAL_BATCH / SAMPLES);
  const tbuf = new Float64Array(EVAL_BATCH);
  const obuf = new Float64Array(2 * EVAL_BATCH);

  const ends = Float64Array.of(job.t0, job.t1);
  const eo = new Float64Array(4);
  ev.evaluateBatch(job.family, job.control, ends, eo);
  evaluations += 2; batches++;
  yield 2;

  let active: Interval[] = [{ t0: job.t0, t1: job.t1, x0: eo[0]!, y0: eo[1]!, x1: eo[2]!, y1: eo[3]!, depth: 0 }];
  const done: Interval[] = [];
  while (active.length) {
    const next: Interval[] = [];
    for (let s = 0; s < active.length; s += perBatch) {
      const chunk = active.slice(s, s + perBatch);
      let n = 0;
      for (const iv of chunk) for (let k = 1; k <= SAMPLES; k++) tbuf[n++] = iv.t0 + ((iv.t1 - iv.t0) * k) / (SAMPLES + 1);
      ev.evaluateBatch(job.family, job.control, tbuf.subarray(0, n), obuf);
      evaluations += n; batches++;
      for (let c = 0; c < chunk.length; c++) {
        const iv = chunk[c]!;
        let worst = 0;
        for (let k = 0; k < SAMPLES; k++) {
          const px = obuf[2 * (c * SAMPLES + k)]!, py = obuf[2 * (c * SAMPLES + k) + 1]!;
          const d = chordDeviation(iv.x0, iv.y0, iv.x1, iv.y1, px, py);
          if (d > worst || Number.isNaN(d)) worst = d; // NaN sticks: the interval is then closed, never refined forever
        }
        if (worst <= job.toleranceUnits || iv.depth >= FINITE_DEPTH_LIMIT || !Number.isFinite(worst)) {
          done.push(iv);
        } else {
          const mid = SAMPLES >> 1; // the sample at 1/2
          const mx = obuf[2 * (c * SAMPLES + mid)]!, my = obuf[2 * (c * SAMPLES + mid) + 1]!;
          const tm = iv.t0 + (iv.t1 - iv.t0) / 2;
          next.push({ t0: iv.t0, t1: tm, x0: iv.x0, y0: iv.y0, x1: mx, y1: my, depth: iv.depth + 1 });
          next.push({ t0: tm, t1: iv.t1, x0: mx, y0: my, x1: iv.x1, y1: iv.y1, depth: iv.depth + 1 });
        }
      }
      yield n;
    }
    active = next;
  }
  done.sort((a, b) => a.t0 - b.t0);
  const params = new Float64Array(done.length + 1);
  const positions = new Float64Array(2 * (done.length + 1));
  done.forEach((iv, i) => { params[i] = iv.t0; positions[2 * i] = iv.x0; positions[2 * i + 1] = iv.y0; });
  const last = done[done.length - 1]!;
  params[done.length] = last.t1;
  positions[2 * done.length] = last.x1;
  positions[2 * done.length + 1] = last.y1;
  return { params, positions, evaluations, batches };
}

export interface CapabilityDiagnostic {
  code: 'unsupportedCurveCapability';
  family: CurveFamily;
  message: string;
  /** The label that stays on the preview. */
  fidelity: 'display';
  previewRetained: true;
}

export type CapabilityCheck = { ok: true } | { ok: false; diagnostic: CapabilityDiagnostic };

/** A family this build cannot evaluate yields a named refusal. The Tier 0 preview stays, labelled display fidelity. */
export function checkCapability(ev: CurveEvaluator, family: CurveFamily): CapabilityCheck {
  if (ev.capabilities.has(family)) return { ok: true };
  return {
    ok: false,
    diagnostic: {
      code: 'unsupportedCurveCapability',
      family,
      message: `The evaluator in this build does not support ${family} curves; the Tier 0 preview stays at display fidelity.`,
      fidelity: 'display',
      previewRetained: true,
    },
  };
}
