import type { CrsAdapter } from './crs';

/** Tabulated source units. `in` and `ft` are defined through exact metre factors. */
export type SourceUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

/** Exact metres per source unit (in = 0.0254 m and ft = 0.3048 m by definition). */
export const METRES_PER_UNIT: Readonly<Record<SourceUnit, number>> = Object.freeze({
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
});

/** A tabulated unit, or an explicit escape hatch for anything else. */
export type UnitSpec = SourceUnit | { readonly unitsPerMetre: number };

/**
 * Six affine coefficients in SVG matrix order `[a, b, c, d, e, f]`:
 *
 *     x' = a*x + c*y + e
 *     y' = b*x + d*y + f
 *
 * Input is metres in the drawing frame, output is native CRS units (degrees for EPSG:4326).
 * Rotation, anisotropic scale and shear all live in a..d, translation in e and f.
 */
export type AffineCalibration = readonly [number, number, number, number, number, number];

/** Row-major 3x3 homography `[h00, h01, h02, h10, h11, h12, h20, h21, h22]`. Opt-in only. */
export type ProjectiveCalibration = readonly [
  number, number, number, number, number, number, number, number, number,
];

export type GeoReference =
  | {
      readonly kind: 'affine';
      readonly unit: UnitSpec;
      readonly calibration: AffineCalibration;
      readonly crs: CrsAdapter;
    }
  | {
      readonly kind: 'projective';
      readonly unit: UnitSpec;
      readonly calibration: ProjectiveCalibration;
      readonly crs: CrsAdapter;
    };

export class GeoReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class NonFiniteCalibrationError extends GeoReferenceError {}
export class DegenerateCalibrationError extends GeoReferenceError {}
export class InvalidUnitError extends GeoReferenceError {}
export class TransformDomainError extends GeoReferenceError {}

/** Metres per source unit for a unit spec. Throws InvalidUnitError for anything unusable. */
export function metresPerUnit(unit: UnitSpec): number {
  if (typeof unit === 'string') {
    const v = METRES_PER_UNIT[unit];
    if (v === undefined) throw new InvalidUnitError(`unknown source unit "${String(unit)}"`);
    return v;
  }
  const u = unit.unitsPerMetre;
  if (!Number.isFinite(u) || u <= 0) {
    throw new InvalidUnitError(`unitsPerMetre must be finite and > 0, got ${u}`);
  }
  return 1 / u;
}

/** Forward and inverse of a validated GeoReference, source units <-> lng/lat. */
export interface GeoTransform {
  readonly geoRef: GeoReference;
  forward(x: number, y: number): [number, number];
  inverse(lng: number, lat: number): [number, number];
}

function assertFinite(values: readonly number[], what: string): void {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new NonFiniteCalibrationError(`${what} coefficient ${i} is not finite (${values[i]})`);
    }
  }
}

/**
 * Validate a GeoReference and build its transform. Rejects non-finite coefficients and a zero or
 * non-finite determinant (or non-finite inverse) with a named error. No tolerance is defined here:
 * conditioning thresholds come from the shared numeric policy (libviprs/pvec#1, P1.2).
 */
export function createGeoTransform(geoRef: GeoReference): GeoTransform {
  const mPerU = metresPerUnit(geoRef.unit);
  const uPerM = 1 / mPerU;
  const crs = geoRef.crs;

  if (geoRef.kind === 'affine') {
    const c = geoRef.calibration;
    if (c.length !== 6) throw new NonFiniteCalibrationError('affine calibration needs 6 coefficients');
    assertFinite(c, 'affine');
    const [a, b, cc, d, e, f] = c;
    const det = a * d - b * cc;
    if (!Number.isFinite(det)) throw new DegenerateCalibrationError(`determinant is not finite (${det})`);
    if (det === 0) throw new DegenerateCalibrationError('determinant is zero');
    const ia = d / det, ib = -b / det, ic = -cc / det, id = a / det;
    if (![ia, ib, ic, id].every(Number.isFinite)) {
      throw new DegenerateCalibrationError('inverse of the calibration is not finite');
    }
    return {
      geoRef,
      forward(x, y) {
        const mx = x * mPerU, my = y * mPerU;
        return crs.forward(a * mx + cc * my + e, b * mx + d * my + f);
      },
      inverse(lng, lat) {
        const [px, py] = crs.inverse(lng, lat);
        const dx = px - e, dy = py - f;
        return [(ia * dx + ic * dy) * uPerM, (ib * dx + id * dy) * uPerM];
      },
    };
  }

  const h = geoRef.calibration;
  if (h.length !== 9) throw new NonFiniteCalibrationError('projective calibration needs 9 coefficients');
  assertFinite(h, 'projective');
  const det =
    h[0] * (h[4] * h[8] - h[5] * h[7]) -
    h[1] * (h[3] * h[8] - h[5] * h[6]) +
    h[2] * (h[3] * h[7] - h[4] * h[6]);
  if (!Number.isFinite(det)) throw new DegenerateCalibrationError(`determinant is not finite (${det})`);
  if (det === 0) throw new DegenerateCalibrationError('determinant is zero');
  // adjugate / det, row-major
  const inv = [
    (h[4] * h[8] - h[5] * h[7]) / det, (h[2] * h[7] - h[1] * h[8]) / det, (h[1] * h[5] - h[2] * h[4]) / det,
    (h[5] * h[6] - h[3] * h[8]) / det, (h[0] * h[8] - h[2] * h[6]) / det, (h[2] * h[3] - h[0] * h[5]) / det,
    (h[3] * h[7] - h[4] * h[6]) / det, (h[1] * h[6] - h[0] * h[7]) / det, (h[0] * h[4] - h[1] * h[3]) / det,
  ];
  if (!inv.every(Number.isFinite)) throw new DegenerateCalibrationError('inverse of the calibration is not finite');
  const apply = (m: readonly number[], x: number, y: number): [number, number] => {
    const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = m as ProjectiveCalibration;
    const w = m6 * x + m7 * y + m8;
    const ox = (m0 * x + m1 * y + m2) / w;
    const oy = (m3 * x + m4 * y + m5) / w;
    if (w === 0 || !Number.isFinite(ox) || !Number.isFinite(oy)) {
      throw new TransformDomainError(`homography is singular at (${x}, ${y})`);
    }
    return [ox, oy];
  };
  return {
    geoRef,
    forward(x, y) {
      const [px, py] = apply(h, x * mPerU, y * mPerU);
      return crs.forward(px, py);
    },
    inverse(lng, lat) {
      const [px, py] = crs.inverse(lng, lat);
      const [mx, my] = apply(inv, px, py);
      return [mx * uPerM, my * uPerM];
    },
  };
}

export interface RoundTripResidual {
  /** Largest |inverse(forward(p)) - p| over the points, in source units. */
  readonly maxAbs: number;
  /** Largest residual divided by max(|x|, |y|, 1) of the same point. */
  readonly maxRelative: number;
  readonly samples: number;
}

/** Forward-then-inverse residual over `[x0, y0, x1, y1, ...]`. */
export function roundTripResidual(t: GeoTransform, xy: ArrayLike<number>): RoundTripResidual {
  let maxAbs = 0, maxRelative = 0;
  const n = xy.length >> 1;
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i]!, y = xy[2 * i + 1]!;
    const [lng, lat] = t.forward(x, y);
    const [rx, ry] = t.inverse(lng, lat);
    const err = Math.hypot(rx - x, ry - y);
    const mag = Math.max(Math.abs(x), Math.abs(y), 1);
    if (err > maxAbs) maxAbs = err;
    if (err / mag > maxRelative) maxRelative = err / mag;
  }
  return { maxAbs, maxRelative, samples: n };
}
