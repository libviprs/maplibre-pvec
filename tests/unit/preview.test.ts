import { describe, expect, it } from 'vitest';
import { measureDeviation, previewTessellate, type CurveRef, type ScreenPipeline } from '../../src/render/preview';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// rotation + anisotropic scale + translation, to make sure error is measured after the transform
const pipe = (scale = 1000): ScreenPipeline => ({ toScreen: (x, y) => { const c = Math.cos(0.7), s = Math.sin(0.7); return [scale * 1.3 * (c * x - s * y) + 50, scale * 0.8 * (s * x + c * y) - 20]; } });

const curves: Record<string, CurveRef> = {
  arc: { kind: 'arc', cx: 0.2, cy: 0.1, r: 0.5, a0: 0.3, a1: 4.1 },
  circle: { kind: 'arc', cx: 0, cy: 0, r: 0.4, a0: 0, a1: 2 * Math.PI },
  ellipse: { kind: 'ellipse', cx: 0, cy: 0, rx: 0.6, ry: 0.25, rot: 0.4, t0: 0, t1: 2 * Math.PI },
};

describe('preview tessellation (#50 M5.3)', () => {
  for (const [name, c] of Object.entries(curves)) {
    it(`${name}: declared error is honest and at most 2.0 px`, () => {
      const r = previewTessellate(c, pipe(), 2.0);
      expect(r.conformance).toBe('display-fidelity');
      expect(r.generation).toBe(0);
      const measured = measureDeviation(c, r.positions, pipe(), 10_000);
      expect(measured).toBeLessThanOrEqual(r.declaredErrorPx);
      expect(r.declaredErrorPx).toBeLessThanOrEqual(2.0);
      // a mutation that under-declares by 2x must be caught
      expect(measured <= r.declaredErrorPx / 2).toBe(false);
    });
  }

  it('trim [0.25, 0.4] never produces a vertex outside the interval and hits the analytic endpoints', () => {
    const c: CurveRef = { kind: 'arc', cx: 0, cy: 0, r: 0.5, a0: 0, a1: 2 * Math.PI, trim: [0.25, 0.4] };
    const r = previewTessellate(c, { toScreen: (x, y) => [x * 1000, y * 1000] }, 1.0);
    expect(r.positions.length).toBeGreaterThan(4);
    const lo = 0.25 * 2 * Math.PI, hi = 0.4 * 2 * Math.PI;
    for (let i = 0; i < r.positions.length; i += 2) {
      let a = Math.atan2(r.positions[i + 1]!, r.positions[i]!); if (a < 0) a += 2 * Math.PI;
      expect(a).toBeGreaterThanOrEqual(lo - 1e-9); expect(a).toBeLessThanOrEqual(hi + 1e-9);
    }
    expect(r.positions[0]!).toBeCloseTo(0.5 * Math.cos(lo), 9);
    expect(r.positions[r.positions.length - 1]!).toBeCloseTo(0.5 * Math.sin(hi), 9);
  });

  it('when the iteration cap binds it reports residual error and stays flagged for refinement', () => {
    const r = previewTessellate(curves.circle!, pipe(100000), 0.01, { maxIterations: 2 });
    expect(r.flaggedForRefinement).toBe(true);
    expect(r.declaredErrorPx).toBeGreaterThan(0.01);
    const ok = previewTessellate(curves.circle!, pipe(), 2.0);
    expect(ok.flaggedForRefinement).toBe(false);
  });

  it('no source or doc sentence calls a preview exact', () => {
    const walk = (d: string): string[] => { try { return readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; }); } catch { return []; } };
    for (const f of [...walk('src'), ...walk('docs')]) {
      const text = readFileSync(f, 'utf8');
      for (const line of text.split('\n')) {
        if (/preview/i.test(line) && /\b(is|are|as|be|being)\s+(mathematically\s+|geometrically\s+)?exact\b/i.test(line) && !/\b(not|never|no)\b/i.test(line)) {
          throw new Error(`${f}: ${line}`);
        }
      }
    }
  });
});
