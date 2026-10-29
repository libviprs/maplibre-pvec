import { describe, expect, it } from 'vitest';
import {
  buildBlockPositions,
  cameraRelativeOrigin,
  checkPrecisionEnvelope,
  chooseLocalOrigin,
  splitHighLow,
} from '../../../src/transform/origin';
import { type CellParams, cellError } from '../helpers/cell';
import { emulateWithOrigin, maxErrorPx, truth, type WorldCamera } from '../helpers/f32';
import { rng } from '../helpers/rng';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base: CellParams = { zoom: 22, magnitude: 1e7, size: 1, lat: 47, rotationDeg: 30, bearing: 0, pitch: 0, dpr: 2 };
const ZOOMS = [0, 4, 8, 12, 14, 16, 18, 20, 22];

describe('M4.5 splitHighLow', () => {
  it('hi is the f32 rounding and lo the exact remainder', () => {
    for (const v of [0, 1, -1, 0.1, 1234567.891, 1e7 + 1e-3, -3.3e-9]) {
      const [hi, lo] = splitHighLow(v);
      expect(hi).toBe(Math.fround(v));
      expect(hi + lo).toBe(v);
    }
  });
  it('the shader formula recovers the f64 difference to better than f32 on the high part alone', () => {
    const v = 1e7 + 1e-3, o = 1e7;
    const [h, l] = splitHighLow(v), [oh, ol] = splitHighLow(o);
    const rec = Math.fround(Math.fround(h - oh) + Math.fround(l - ol));
    expect(Math.abs(rec - 1e-3)).toBeLessThan(1e-9);
    expect(Math.abs(Math.fround(v) - Math.fround(o) - 1e-3)).toBeGreaterThan(1e-3 * 0.9);
  });
});

describe('M4.5 vertex positional error on the 1e7-unit fixture, devicePixelRatio 2', () => {
  it('high/low stays at or below 0.25 device px across zoom 0 to 22', () => {
    const rows: string[] = [];
    for (const zoom of ZOOMS) {
      const hl = cellError({ ...base, zoom }, 'highlow');
      const og = cellError({ ...base, zoom }, 'origin');
      const nv = cellError({ ...base, zoom }, 'naive');
      rows.push(`PRECISION zoom ${zoom}: naive ${nv.toExponential(2)} origin ${og.toExponential(2)} highlow ${hl.toExponential(2)}`);
      expect(hl, `zoom ${zoom}`).toBeLessThanOrEqual(0.25);
    }
    console.info(rows.join('\n'));
  });

  it('wide blocks (+-5 km) measure the high/low split against a local origin alone', () => {
    const rows: string[] = [];
    let ratioAt22 = 0;
    for (const zoom of [14, 18, 20, 22]) {
      const c = { ...base, zoom, spread: 5e6 };
      const hl = cellError(c, 'highlow'), og = cellError(c, 'origin'), nv = cellError(c, 'naive');
      if (zoom === 22) ratioAt22 = og / hl;
      rows.push(`PRECISION wide-block zoom ${zoom}: naive ${nv.toExponential(2)} origin ${og.toExponential(2)} highlow ${hl.toExponential(2)}`);
      expect(hl, `zoom ${zoom}`).toBeLessThanOrEqual(0.25);
    }
    console.info(rows.join('\n'));
    // a local origin alone is already inside 0.25 px here; the split buys another 100x or so
    expect(ratioAt22).toBeGreaterThan(5);
  });

  it('naive single-f32 world coordinates lose at least 8 device px at zoom 22', () => {
    expect(cellError({ ...base, zoom: 22 }, 'naive')).toBeGreaterThanOrEqual(8);
  });

  it('sub-millimetre geometry (1e-3 unit) stays at or below 0.25 px at zoom 22', () => {
    for (const lat of [0, 47, 84]) {
      expect(cellError({ ...base, zoom: 22, size: 1e-3, lat }, 'highlow')).toBeLessThanOrEqual(0.25);
    }
  });
});

describe('M4.5 rebase bookkeeping', () => {
  it('panning 10 000 px across at least 20 block-origin changes never displaces a vertex by more than 0.05 px', () => {
    const zoom = 20, W = 512 * 2 ** zoom;
    const blockPx = 400, nBlocks = 40; // 16 000 px of drawing
    const r = rng(3);
    const ox = 0.5 + 123456 / W, oy = 0.3;
    const cam0: WorldCamera = { cx: ox, cy: oy, zoom, bearing: 20, pitch: 0, width: 1024, height: 768, dpr: 2 };
    // vertices along a line, grouped into blocks of 400 px
    const verts: number[][] = [];
    for (let b = 0; b < nBlocks; b++) {
      const v: number[] = [];
      for (let i = 0; i < 20; i++) v.push(ox + (b * blockPx + r() * blockPx) / W, oy + (r() * 300) / W);
      verts.push(v);
    }
    const originsSeen = new Set<string>();
    let worst = 0, frames = 0;
    for (let pan = 0; pan <= 10_000; pan += 250) {
      const cam = { ...cam0, cx: ox + pan / W };
      for (const v of verts) {
        const world = Float64Array.from(v);
        const mins = [Math.min(...v.filter((_, i) => i % 2 === 0)), Math.min(...v.filter((_, i) => i % 2 === 1))];
        const maxs = [Math.max(...v.filter((_, i) => i % 2 === 0)), Math.max(...v.filter((_, i) => i % 2 === 1))];
        const origin = chooseLocalOrigin(mins[0]!, mins[1]!, maxs[0]!, maxs[1]!);
        // the rebased variant: same vertices, origin moved to the previous grid cell and back by a block
        const shifted = { x: origin.x + 0.37 * blockPx / W, y: origin.y - 0.21 * blockPx / W };
        const a = emulateWithOrigin('highlow', world, origin, cam);
        const b = emulateWithOrigin('highlow', world, shifted, cam);
        const t = truth(world, cam);
        if (maxErrorPx(t, t, cam) === 0) {
          for (let i = 0; i < a.length; i += 2) {
            if (Math.abs(t[i]!) > 4000 || Math.abs(t[i + 1]!) > 4000) continue;
            worst = Math.max(worst, Math.hypot(a[i]! - b[i]!, a[i + 1]! - b[i + 1]!));
          }
        }
        originsSeen.add(`${origin.x}`);
      }
      frames++;
    }
    expect(originsSeen.size).toBeGreaterThanOrEqual(20);
    expect(frames).toBeGreaterThan(30);
    console.info(`PRECISION rebase jitter worst ${worst.toExponential(2)} px over ${originsSeen.size} origins`);
    expect(worst).toBeLessThanOrEqual(0.05);
  });

  it('identical bounds always choose the identical origin', () => {
    expect(chooseLocalOrigin(0.123, 0.456, 0.124, 0.457)).toEqual(chooseLocalOrigin(0.123, 0.456, 0.124, 0.457));
  });

  it('block positions and the camera-relative origin split exactly in f64', () => {
    const o = { x: 0.5, y: 0.25 };
    const { hi, lo } = buildBlockPositions([0.5 + 1e-9, 0.25 - 2e-9], o);
    expect(hi[0]! + lo[0]!).toBeCloseTo(1e-9, 15);
    const u = cameraRelativeOrigin(o, 0.5 + 3e-7, 0.25);
    expect(u[0]! + u[2]!).toBeCloseTo(3e-7, 14);
  });
});

describe('M4.5 envelope diagnostics', () => {
  it('a 1e9-magnitude coordinate emits a diagnostic instead of degrading silently', () => {
    const seen: unknown[] = [];
    const out = checkPrecisionEnvelope({ sourceMagnitude: 1e9, zoom: 10, latitude: 10 }, (d) => seen.push(d));
    expect(out).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(out[0]).toMatchObject({ code: 'precision-envelope', quantity: 'sourceMagnitude', value: 1e9, limit: 1e7 });
    expect(checkPrecisionEnvelope({ sourceMagnitude: 1e7, zoom: 22, latitude: 84 })).toEqual([]);
    expect(checkPrecisionEnvelope({ sourceMagnitude: 5, zoom: 24, latitude: 90 }).map((d) => d.quantity)).toEqual(['zoom', 'latitude']);
  });
});

describe('M4.5 shader include', () => {
  it('position.glsl reconstructs (hi - originHi) + (lo - originLo)', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../src/render/shaders/position.glsl', import.meta.url)), 'utf8');
    expect(src).toContain('(aPosHigh - uOriginHigh) + (aPosLow - uOriginLow)');
  });
});
