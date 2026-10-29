import { budget } from '../helpers/budget';
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CurveDataError, packCurves, splitForBatches } from '../../../src/decode/advanced';
import { EVAL_BATCH, checkCapability, refineSteps } from '../../../src/workers/evaluator';
import { DoubleEvaluator, measureSource, splineFixture } from '../helpers/refine';

function runSync(ev: DoubleEvaluator, control: Float64Array, chord: number) {
  const g = refineSteps(ev, { family: 'bezier', control, t0: 0, t1: 1, toleranceUnits: chord });
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

describe('M6.1 packed batches', () => {
  it('evaluates in batches of at least 4096 parameters on the spline-heavy fixture', () => {
    const ev = new DoubleEvaluator();
    for (const e of splineFixture(40, 3)) runSync(ev, e.control, 1e-5);
    expect(EVAL_BATCH).toBeGreaterThanOrEqual(4096);
    // every call except the last of each pass is a full batch; at tight tolerance most calls are full
    expect(ev.maxBatch).toBeLessThanOrEqual(EVAL_BATCH);
    expect(ev.maxBatch).toBeGreaterThanOrEqual(2000);
    expect(ev.calls).toBeLessThan(ev.evaluations / 100);
  });

  it('tessellates to the chord bound against f64 ground truth', () => {
    const ev = new DoubleEvaluator();
    for (const e of splineFixture(30, 5)) {
      const chord = 0.01;
      const p = runSync(ev, e.control, chord);
      expect(measureSource(e.control, p.params, p.positions, 1000)).toBeLessThanOrEqual(chord);
      expect(p.params[0]).toBe(0);
      expect(p.params[p.params.length - 1]).toBe(1);
    }
  });

  it('splits control data into whole-curve batches of at most the batch size', () => {
    const lens = Array.from({ length: 50 }, (_, i) => 100 + i * 37);
    const parts = splitForBatches(lens, 1000);
    expect(parts.flat().length).toBe(50);
    for (const p of parts) expect(p.reduce((a, i) => a + lens[i]!, 0)).toBeLessThanOrEqual(budget(1000 + Math.max(...lens)));
  });
});

describe('M6.1 decode validation', () => {
  const base = { family: 'nurbs' as const, degree: 3, domain: [0, 1] as [number, number], trims: [] as [number, number][] };
  const ok = {
    ...base,
    points: [0, 0, 1, 2, 2, 2, 3, 0],
    knots: [0, 0, 0, 0, 1, 1, 1, 1],
    weights: [1, 2, 2, 1],
  };
  it('packs control points, knots, weights, domain and trims into one buffer with offsets', () => {
    const p = packCurves([ok, { ...ok, trims: [[0.2, 0.4]] }]);
    expect(p.count).toBe(2);
    expect(p.offsets.length).toBe(3);
    expect(p.data.byteLength).toBe(p.offsets[2]! * 8);
  });
  it('rejects non-finite and non-positive weights instead of clamping', () => {
    for (const w of [0, -1, NaN, Infinity]) {
      expect(() => packCurves([{ ...ok, weights: [1, w, 1, 1] }])).toThrow(CurveDataError);
    }
  });
  it('accepts weight ratios up to 1e3 and triple knots', () => {
    expect(() => packCurves([{ ...ok, weights: [1, 1000, 1, 1] }])).not.toThrow();
    expect(() => packCurves([{ ...ok, points: Array(14).fill(1), weights: Array(7).fill(1), degree: 3, knots: [0, 0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1, 1] }])).not.toThrow();
  });
  it('rejects a weight ratio above 1e3 only when asked to', () => {
    expect(() => packCurves([{ ...ok, weights: [1, 1e4, 1, 1] }])).not.toThrow();
  });
  it('rejects decreasing knots and inconsistent counts', () => {
    expect(() => packCurves([{ ...ok, knots: [0, 0, 0, 0, 1, 0.5, 1, 1] }])).toThrow(CurveDataError);
    expect(() => packCurves([{ ...ok, weights: [1, 1, 1] }])).toThrow(CurveDataError);
  });
});

describe('M6.1 capability refusal', () => {
  it('names the missing capability and leaves the preview in place', () => {
    const ev = new DoubleEvaluator(['bezier']);
    expect(checkCapability(ev, 'bezier')).toEqual({ ok: true });
    const r = checkCapability(ev, 'nurbs');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostic.code).toBe('unsupportedCurveCapability');
      expect(r.diagnostic.family).toBe('nurbs');
      expect(r.diagnostic.fidelity).toBe('display');
      expect(r.diagnostic.previewRetained).toBe(true);
    }
  });
});

describe('M6.1 gate: no curve mathematics in src', () => {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : []));
  const banned = /de\s?boor|cox[-\s]?de[-\s]?boor|knot\s?insertion|insertKnot|bernstein|basisFunction|bspline_?basis|nurbsPoint/i;
  it('finds no basis function, de Boor, Cox-de Boor or knot insertion code', () => {
    const hits = walk('src').filter((f) => banned.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
    expect(hits).toEqual([]);
  });
  it('the gate itself fires on a basis function', () => {
    expect(banned.test('function bernsteinBasis(i, n, t) {}')).toBe(true);
  });
});
