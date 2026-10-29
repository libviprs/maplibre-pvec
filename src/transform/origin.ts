import { PRECISION_ENVELOPE } from '../config/defaults';

/** Split an f64 into an f32 high part and the f64 remainder (to be stored as f32). */
export function splitHighLow(v: number): [number, number] {
  const hi = Math.fround(v);
  return [hi, v - hi];
}

/** Block origin in f64 world coordinates (normalised mercator, y down). */
export interface LocalOrigin {
  readonly x: number;
  readonly y: number;
}

/** Origins snap to a power-of-two grid so identical bounds always give the identical origin. */
export const ORIGIN_GRID = 2 ** -24;

export function chooseLocalOrigin(minX: number, minY: number, maxX: number, maxY: number): LocalOrigin {
  const snap = (v: number) => Math.round(v / ORIGIN_GRID) * ORIGIN_GRID;
  return { x: snap((minX + maxX) / 2), y: snap((minY + maxY) / 2) };
}

/**
 * Vertex attributes for one block: world positions (`[x0, y0, ...]`, f64) minus the block origin
 * in f64, then split into f32 high and low parts.
 */
export function buildBlockPositions(worldXY: ArrayLike<number>, origin: LocalOrigin) {
  const n = worldXY.length >> 1;
  const hi = new Float32Array(2 * n);
  const lo = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const [hx, lx] = splitHighLow(worldXY[2 * i]! - origin.x);
    const [hy, ly] = splitHighLow(worldXY[2 * i + 1]! - origin.y);
    hi[2 * i] = hx;
    hi[2 * i + 1] = hy;
    lo[2 * i] = lx;
    lo[2 * i + 1] = ly;
  }
  return { hi, lo };
}

/**
 * Per-frame uniform for one block: `[originHiX, originHiY, originLoX, originLoY]` of
 * (camera - blockOrigin), subtracted in f64 so it is small and exact when the camera is near.
 * The shader computes `(hi - originHi) + (lo - originLo)`, the position relative to the camera.
 */
export function cameraRelativeOrigin(origin: LocalOrigin, cameraX: number, cameraY: number): Float32Array {
  const [hx, lx] = splitHighLow(cameraX - origin.x);
  const [hy, ly] = splitHighLow(cameraY - origin.y);
  return new Float32Array([hx, hy, lx, ly]);
}

export interface PrecisionDiagnostic {
  readonly code: 'precision-envelope';
  readonly quantity: 'sourceMagnitude' | 'zoom' | 'latitude';
  readonly value: number;
  readonly limit: number;
  readonly message: string;
}

/** Emit a diagnostic for every quantity outside the documented envelope. Never degrades silently. */
export function checkPrecisionEnvelope(
  input: { sourceMagnitude: number; zoom: number; latitude: number },
  sink?: (d: PrecisionDiagnostic) => void,
): PrecisionDiagnostic[] {
  const out: PrecisionDiagnostic[] = [];
  const check = (quantity: PrecisionDiagnostic['quantity'], value: number, limit: number) => {
    if (!(Math.abs(value) <= limit)) {
      const d: PrecisionDiagnostic = {
        code: 'precision-envelope',
        quantity,
        value,
        limit,
        message: `${quantity} ${value} is outside the documented precision envelope (|v| <= ${limit}); positional error may exceed 0.25 device px`,
      };
      out.push(d);
      sink?.(d);
    }
  };
  check('sourceMagnitude', input.sourceMagnitude, PRECISION_ENVELOPE.maxSourceMagnitude);
  check('zoom', input.zoom, PRECISION_ENVELOPE.maxZoom);
  check('latitude', input.latitude, PRECISION_ENVELOPE.maxLatitude);
  return out;
}
