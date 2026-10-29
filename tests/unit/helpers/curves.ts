import type { CurveRef } from '../../../src/transform/screen_error';

/** Test-only analytic stand-ins for the WASM evaluator's known-truth families (M2.1 lands them for real). */
export const arc = (radius: number, sweep: number, cx = 0, cy = 0): CurveRef => ({
  domain: [0, 1],
  point: (t) => {
    const phi = (t - 0.5) * sweep;
    return [cx + radius * Math.sin(phi), cy - radius + radius * Math.cos(phi)];
  },
});
export const line = (ax: number, ay: number, bx: number, by: number): CurveRef => ({
  domain: [0, 1],
  point: (t) => [ax + (bx - ax) * t, ay + (by - ay) * t],
});
export const ellipse = (rx: number, ry: number, a0: number, a1: number): CurveRef => ({
  domain: [0, 1],
  point: (t) => [rx * Math.cos(a0 + (a1 - a0) * t), ry * Math.sin(a0 + (a1 - a0) * t)],
});
export const cubic = (p: [number, number][]): CurveRef => ({
  domain: [0, 1],
  point: (t) => {
    const u = 1 - t;
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [0, 1].map((k) => w[0]! * p[0]![k]! + w[1]! * p[1]![k]! + w[2]! * p[2]![k]! + w[3]! * p[3]![k]!) as [number, number];
  },
});
export const spiral = (turns: number, r0: number, r1: number): CurveRef => ({
  domain: [0, 1],
  point: (t) => {
    const a = turns * 2 * Math.PI * t, r = r0 + (r1 - r0) * t;
    return [r * Math.cos(a), r * Math.sin(a)];
  },
});
