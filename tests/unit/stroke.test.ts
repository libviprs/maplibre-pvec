import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildStrokeMesh } from '../../src/render/stroke/mesh';
import { dashRuns, dashOn } from '../../src/render/stroke/dash';
import { FRAGMENT_SHADER, VERTEX_SHADER } from '../../src/render/stroke/shaders';

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

function joinVerts(points: number[], opts: Parameters<typeof buildStrokeMesh>[1]) {
  return buildStrokeMesh(Float64Array.from(points), opts).joins[0]!;
}

describe('stroke mesh (#50 M5.4)', () => {
  const deg5 = [0, 0, 100, 0, 100 - 100 * Math.cos((5 * Math.PI) / 180), 100 * Math.sin((5 * Math.PI) / 180)];

  it('falls back to bevel past the miter limit and no vertex exceeds limit x halfWidth', () => {
    const opts = { width: 4, join: 'miter', cap: 'butt', miterLimit: 4 } as const;
    const j = joinVerts(deg5, opts);
    expect(j.kind).toBe('bevel');
    for (let i = 0; i < j.vertices.length; i += 2) {
      expect(dist(j.vertices[i]!, j.vertices[i + 1]!, 100, 0)).toBeLessThanOrEqual(opts.miterLimit * 2 + 1e-9);
    }
  });

  it('keeps the miter when inside the limit (90 degrees, tip at halfWidth*sqrt2)', () => {
    const j = joinVerts([0, 0, 10, 0, 10, 10], { width: 4, join: 'miter', cap: 'butt', miterLimit: 4 });
    expect(j.kind).toBe('miter');
    const far = Math.max(...Array.from({ length: j.vertices.length / 2 }, (_, i) => dist(j.vertices[2 * i]!, j.vertices[2 * i + 1]!, 10, 0)));
    expect(far).toBeCloseTo(2 * Math.SQRT2, 6);
  });

  it('round joins sit on the halfWidth circle', () => {
    const j = joinVerts([0, 0, 10, 0, 10, 10], { width: 6, join: 'round', cap: 'butt', miterLimit: 4 });
    expect(j.kind).toBe('round');
    for (let i = 0; i < j.vertices.length; i += 2) expect(dist(j.vertices[i]!, j.vertices[i + 1]!, 10, 0)).toBeCloseTo(3, 6);
  });

  it('caps: butt adds nothing, square extends halfWidth, round stays on the circle', () => {
    const ext = (cap: 'butt' | 'square' | 'round') => {
      const m = buildStrokeMesh(Float64Array.of(0, 0, 10, 0), { width: 4, join: 'miter', cap, miterLimit: 4 });
      let minX = Infinity;
      for (let i = 0; i < m.positions.length; i += 2) minX = Math.min(minX, m.positions[i]!);
      return { minX, caps: m.caps };
    };
    expect(ext('butt').minX).toBeCloseTo(0, 6);
    expect(ext('square').minX).toBeCloseTo(-2, 6);
    expect(ext('round').minX).toBeCloseTo(-2, 6);
    const rc = ext('round').caps[0]!;
    for (let i = 0; i < rc.vertices.length; i += 2) expect(dist(rc.vertices[i]!, rc.vertices[i + 1]!, 0, 0)).toBeCloseTo(2, 6);
  });

  it('body width equals the requested width at any bearing', () => {
    for (const deg of [0, 22.5, 45]) {
      const a = (deg * Math.PI) / 180;
      const m = buildStrokeMesh(Float64Array.of(0, 0, 50 * Math.cos(a), 50 * Math.sin(a)), { width: 4, join: 'miter', cap: 'butt', miterLimit: 4 });
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < m.positions.length; i += 2) {
        const across = -Math.sin(a) * m.positions[i]! + Math.cos(a) * m.positions[i + 1]!;
        min = Math.min(min, across); max = Math.max(max, across);
      }
      expect(max - min).toBeCloseTo(4, 4); // f32 mesh
    }
  });

  it('skips degenerate points instead of emitting NaN', () => {
    const m = buildStrokeMesh(Float64Array.of(0, 0, 0, 0, 10, 0, NaN, 1), { width: 2, join: 'miter', cap: 'butt', miterLimit: 4 });
    expect(Array.from(m.positions).every(Number.isFinite)).toBe(true);
  });
});

describe('dash (#50 M5.4)', () => {
  it('100-segment polyline has the same dash runs as one segment of equal length', () => {
    const pts: number[] = [];
    let x = 0;
    for (let i = 0; i <= 100; i++) { pts.push(x, Math.sin(i) * 0); x += 7.3; }
    const single = [0, 0, x - 7.3, 0];
    const a = dashRuns(Float64Array.from(pts), [8, 4]);
    const b = dashRuns(Float64Array.from(single), [8, 4]);
    expect(a.length).toBe(b.length);
    a.forEach((r, i) => { expect(r[0]).toBeCloseTo(b[i]![0], 9); expect(r[1]).toBeCloseTo(b[i]![1], 9); });
  });

  it('dashOn follows the pattern with phase', () => {
    expect(dashOn(0, [8, 4])).toBe(true);
    expect(dashOn(9, [8, 4])).toBe(false);
    expect(dashOn(12.5, [8, 4])).toBe(true);
    expect(dashOn(0, [8, 4], 8)).toBe(false);
  });
});

describe('no wide GL lines (#50 M5.4)', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
  it('no source calls gl.lineWidth with a value above 1', () => {
    for (const f of walk('src')) {
      for (const m of readFileSync(f, 'utf8').matchAll(/lineWidth\(\s*([^)]*)\)/g)) {
        expect(Number(m[1]), `${f}: lineWidth(${m[1]})`).toBeLessThanOrEqual(1);
      }
    }
  });
  it('shaders are GLSL ES 3.00, expand instanced quads and feather by 1 css px scaled by dpr', () => {
    expect(VERTEX_SHADER.startsWith('#version 300 es')).toBe(true);
    expect(FRAGMENT_SHADER.startsWith('#version 300 es')).toBe(true);
    expect(VERTEX_SHADER).toContain('a_p0');
    expect(FRAGMENT_SHADER).toContain('u_dpr');
  });
});
