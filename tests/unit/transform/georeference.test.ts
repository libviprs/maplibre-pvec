import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Epsg4326Adapter } from '../../../src/transform/crs';
import {
  DegenerateCalibrationError,
  type GeoReference,
  InvalidUnitError,
  METRES_PER_UNIT,
  NonFiniteCalibrationError,
  type SourceUnit,
  createGeoTransform,
  metresPerUnit,
  roundTripResidual,
} from '../../../src/transform/georeference';
import { anchoredGeoRef } from '../helpers/scene';
import { rng } from '../helpers/rng';

const identity = (unit: GeoReference['unit'] = 'm'): GeoReference => ({
  kind: 'affine',
  unit,
  calibration: [1, 0, 0, 1, 0, 0],
  crs: Epsg4326Adapter,
});

const HERE = fileURLToPath(new URL('.', import.meta.url));

describe('M4.1 units', () => {
  it('uses the exact tabulated factors, asserted against hand-computed constants', () => {
    expect(METRES_PER_UNIT.mm).toBe(0.001);
    expect(METRES_PER_UNIT.cm).toBe(0.01);
    expect(METRES_PER_UNIT.m).toBe(1);
    expect(METRES_PER_UNIT.in).toBe(0.0254);
    expect(METRES_PER_UNIT.ft).toBe(0.3048);
    // 1 ft = 12 in exactly: 0.3048 / 0.0254 = 12
    expect(0.3048 / 0.0254).toBeCloseTo(12, 14);
    // hand-computed: 100 in = 2.54 m, 10 ft = 3.048 m
    expect(createGeoTransform(identity('in')).forward(100, 0)[0]).toBeCloseTo(2.54, 14);
    expect(createGeoTransform(identity('ft')).forward(10, 0)[0]).toBeCloseTo(3.048, 14);
    expect(createGeoTransform(identity('in')).forward(100, 0)[0]).toBe(100 * 0.0254);
  });

  it('supports the unitsPerMetre escape hatch and rejects unusable values', () => {
    expect(metresPerUnit({ unitsPerMetre: 4 })).toBe(0.25);
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => metresPerUnit({ unitsPerMetre: bad })).toThrow(InvalidUnitError);
    }
    expect(() => metresPerUnit('yd' as SourceUnit)).toThrow(InvalidUnitError);
  });
});

describe('M4.1 degenerate calibrations are rejected with a named error', () => {
  const mk = (c: number[]): GeoReference => ({ ...identity(), calibration: c as never });
  it('zero determinant', () => {
    expect(() => createGeoTransform(mk([1, 2, 2, 4, 0, 0]))).toThrow(DegenerateCalibrationError);
    expect(() => createGeoTransform(mk([0, 0, 0, 0, 5, 5]))).toThrow(DegenerateCalibrationError);
  });
  it('non-finite determinant from finite coefficients', () => {
    expect(() => createGeoTransform(mk([1e200, 0, 0, 1e200, 0, 0]))).toThrow(DegenerateCalibrationError);
  });
  it('any non-finite coefficient', () => {
    for (let i = 0; i < 6; i++) {
      for (const bad of [NaN, Infinity, -Infinity]) {
        const c = [1, 0, 0, 1, 0, 0];
        c[i] = bad;
        expect(() => createGeoTransform(mk(c))).toThrow(NonFiniteCalibrationError);
      }
    }
  });
  it('projective: zero determinant and non-finite coefficient', () => {
    const p = (h: number[]): GeoReference => ({ kind: 'projective', unit: 'm', calibration: h as never, crs: Epsg4326Adapter });
    expect(() => createGeoTransform(p([1, 0, 0, 2, 0, 0, 3, 0, 0]))).toThrow(DegenerateCalibrationError);
    expect(() => createGeoTransform(p([1, 0, 0, 0, 1, NaN, 0, 0, 1]))).toThrow(NonFiniteCalibrationError);
  });
  it('the error is named, not a plain Error', () => {
    try {
      createGeoTransform(mk([1, 2, 2, 4, 0, 0]));
    } catch (e) {
      expect((e as Error).name).toBe('DegenerateCalibrationError');
    }
  });
});

describe('M4.1 round trip', () => {
  const units: SourceUnit[] = ['mm', 'cm', 'm', 'in', 'ft'];
  const magnitudes = [1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7];
  const perCell = 1_000_000 / (units.length * magnitudes.length);

  function sample(seed: number, mag: number, n: number): Float64Array {
    const r = rng(seed);
    const xy = new Float64Array(2 * n);
    for (let i = 0; i < xy.length; i++) xy[i] = (r() * 2 - 1) * mag;
    return xy;
  }

  it('1e6 points, magnitudes 1e0..1e7: residual <= 1e-9 x magnitude when anchored at 0,0', () => {
    const lines: string[] = [];
    let total = 0;
    for (const unit of units) {
      const worst: number[] = [];
      // degrees per metre at the equator, rotated 30 degrees, mild shear through anisotropy
      const t = createGeoTransform({ ...anchoredGeoRef({ lng: 0, lat: 0, rotationDeg: 30, unit, anisotropy: 1.1 }) });
      for (const mag of magnitudes) {
        const xy = sample(unit.length * 7 + mag, mag, perCell);
        const r = roundTripResidual(t, xy);
        total += r.samples;
        worst.push(r.maxRelative);
        expect(r.maxRelative, `${unit} @ ${mag}`).toBeLessThanOrEqual(1e-9);
      }
      lines.push(`RESIDUAL anchored(0,0) ${unit}: ${worst.map((w) => w.toExponential(2)).join(' ')}`);
    }
    expect(total).toBeGreaterThanOrEqual(1_000_000 - 40);
    console.info(`RESIDUAL magnitudes ${magnitudes.join(' ')}\n${lines.join('\n')}`);
  });

  it('real-world anchor (47.4 N, 8.5 E): residual stays inside the f64 floor of the stored lng/lat', () => {
    const lines: string[] = [];
    for (const unit of units) {
      const g = anchoredGeoRef({ lng: 8.5, lat: 47.4, rotationDeg: 30, unit, anisotropy: 1.1 });
      const t = createGeoTransform(g);
      const metres = metresPerUnit(unit);
      // one ulp of the degree value is the floor: ~7e-15 deg = 7.9e-10 m. Allow 8 ulp of the output.
      const floorUnits = (8 * 2 ** -47 * 111_320 * 1.6) / metres; // ulp(47.4) = 2^-47 deg, ~1.6x for lng at 47 N
      const worst: number[] = [];
      for (const mag of [1e0, 1e3, 1e5, 1e7]) {
        const r = roundTripResidual(t, sample(mag, mag, 20_000));
        worst.push(r.maxAbs);
        expect(r.maxAbs, `${unit} @ ${mag}`).toBeLessThanOrEqual(Math.max(1e-9 * mag, floorUnits));
      }
      lines.push(`RESIDUAL anchored(8.5,47.4) ${unit} abs @1e0 1e3 1e5 1e7: ${worst.map((w) => w.toExponential(2)).join(' ')} (floor ${floorUnits.toExponential(2)})`);
    }
    console.info(lines.join('\n'));
  });
});

describe('M4.1 projective calibration', () => {
  it('is inert unless supplied: affine references never route through the homography code', () => {
    const t = createGeoTransform(identity());
    expect(t.geoRef.kind).toBe('affine');
  });
  it('round-trips a supplied homography', () => {
    const h = [1.1, 0.05, 3, -0.02, 0.9, 4, 1e-6, -2e-6, 1] as const;
    const t = createGeoTransform({ kind: 'projective', unit: 'm', calibration: h, crs: Epsg4326Adapter });
    const [lng, lat] = t.forward(120, -80);
    const [x, y] = t.inverse(lng, lat);
    expect(x).toBeCloseTo(120, 9);
    expect(y).toBeCloseTo(-80, 9);
  });
});

describe('M4.1 georeferencing is external', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }
  it('no code path reads georeferencing out of the .pvec container', () => {
    const files = walk(join(HERE, '../../../src/transform')).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // transform modules import only from the transform, config and (type-free) siblings
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      for (const i of imports) {
        expect(i, `${f} imports ${i}`).toMatch(/^\.\/|^\.\.\/config\//);
        expect(i).not.toMatch(/container|pvec|wasm|source/i);
      }
      expect(src).not.toMatch(/readGeo|georefFrom|fromContainer|\.pvec/i);
    }
  });
});
