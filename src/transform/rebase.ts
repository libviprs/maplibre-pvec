import { DISPLAY_FIDELITY_TARGET_PX } from '../config/defaults';
import { type GeoReference, type GeoTransform, createGeoTransform, metresPerUnit } from './georeference';
import { type LocalOrigin, buildBlockPositions, chooseLocalOrigin } from './origin';
import { lngLatToMercator } from './projection';
import { type TransformPipeline, sourceToDevicePx } from './screen_error';

/** Diagnostic payload for the `georeferencechange` event (M7.3). */
export interface GeoReferenceChange {
  readonly epoch: number;
  readonly rebuiltBlocks: number;
  readonly droppedTessellations: number;
}

/**
 * Holds the current transform and a monotonic transformEpoch. Replacing the GeoReference never
 * touches decoded semantic data: callers keep that separately, and this state has no handle on it.
 * A rejected GeoReference leaves the previous one and the epoch untouched.
 */
export class GeoReferenceState {
  #transform: GeoTransform;
  #epoch = 0;

  constructor(initial: GeoReference) {
    this.#transform = createGeoTransform(initial);
  }
  get transform(): GeoTransform {
    return this.#transform;
  }
  /** Bumped on every successful update; results built for an older epoch must be discarded. */
  get transformEpoch(): number {
    return this.#epoch;
  }
  set(next: GeoReference): { previous: GeoTransform; current: GeoTransform; epoch: number } {
    const current = createGeoTransform(next); // throws before any state changes
    const previous = this.#transform;
    this.#transform = current;
    return { previous, current, epoch: ++this.#epoch };
  }
}

/** Source XY to normalised mercator world XY (f64). */
export function sourceToWorld(t: GeoTransform, x: number, y: number): [number, number] {
  const [lng, lat] = t.forward(x, y);
  return lngLatToMercator(lng, lat);
}

/**
 * Incremental position-buffer rebuild: only positions are regenerated from the f64 source
 * coordinates, topology and index buffers are never inputs. `step` does bounded work (one unit per
 * vertex per phase: forward transform, then hi/low split) so the caller can spread the rebuild
 * over frames under the upload budget.
 */
export class PositionRebuild {
  readonly hi: Float32Array;
  readonly lo: Float32Array;
  readonly #world: Float64Array;
  #bounds = [Infinity, Infinity, -Infinity, -Infinity];
  #origin: LocalOrigin | null = null;
  #next = 0;
  #phase: 0 | 1 = 0;

  constructor(
    readonly sourceXY: Float64Array,
    readonly transform: GeoTransform,
    readonly epoch: number,
  ) {
    this.#world = new Float64Array(sourceXY.length);
    this.hi = new Float32Array(sourceXY.length);
    this.lo = new Float32Array(sourceXY.length);
  }

  /** The block origin, available once the first phase has finished. */
  get origin(): LocalOrigin | null {
    return this.#origin;
  }

  get done(): boolean {
    return this.#phase === 1 && this.#next >= this.sourceXY.length >> 1;
  }

  /** Do up to `budget` vertex units of work. Returns the units actually done. */
  step(budget: number): number {
    const n = this.sourceXY.length >> 1;
    let left = budget;
    while (left > 0 && !this.done) {
      const end = Math.min(n, this.#next + left);
      if (this.#phase === 0) {
        const b = this.#bounds as [number, number, number, number];
        for (let i = this.#next; i < end; i++) {
          const [wx, wy] = sourceToWorld(this.transform, this.sourceXY[2 * i]!, this.sourceXY[2 * i + 1]!);
          this.#world[2 * i] = wx;
          this.#world[2 * i + 1] = wy;
          if (wx < b[0]) b[0] = wx;
          if (wy < b[1]) b[1] = wy;
          if (wx > b[2]) b[2] = wx;
          if (wy > b[3]) b[3] = wy;
        }
      } else {
        const part = buildBlockPositions(this.#world.subarray(2 * this.#next, 2 * end), this.#origin!);
        this.hi.set(part.hi, 2 * this.#next);
        this.lo.set(part.lo, 2 * this.#next);
      }
      left -= end - this.#next;
      this.#next = end;
      if (this.#next >= n && this.#phase === 0) {
        const [x0, y0, x1, y1] = this.#bounds as [number, number, number, number];
        this.#origin = n ? chooseLocalOrigin(x0, y0, x1, y1) : { x: 0, y: 0 };
        this.#phase = 1;
        this.#next = 0;
        if (n === 0) break;
      }
    }
    return budget - left;
  }
}

export interface DeclaredTessellation {
  readonly blockId: number;
  /** Screen error the tessellation was built to, in device px. */
  readonly declaredErrorPx: number;
  /** A source point inside the tessellation, where the local scale is sampled. */
  readonly sourceCenter: readonly [number, number];
}

function localJacobian(p: TransformPipeline, cx: number, cy: number, h: number): [number, number, number, number] {
  const [x1, y1] = sourceToDevicePx(p, cx + h, cy), [x0, y0] = sourceToDevicePx(p, cx - h, cy);
  const [x3, y3] = sourceToDevicePx(p, cx, cy + h), [x2, y2] = sourceToDevicePx(p, cx, cy - h);
  return [(x1 - x0) / (2 * h), (x3 - x2) / (2 * h), (y1 - y0) / (2 * h), (y3 - y2) / (2 * h)];
}

/**
 * Does a tessellation built under `before` still meet the budget under `after`? The declared
 * error is scaled by the largest singular value of J_after * J_before^-1 at the tessellation
 * centre: a translation keeps that at 1, a 3x scale change triples it.
 */
export function tessellationStillValid(
  before: TransformPipeline,
  after: TransformPipeline,
  tess: DeclaredTessellation,
  budgetPx: number = DISPLAY_FIDELITY_TARGET_PX,
  geoUnit = before.transform.geoRef.unit,
): boolean {
  const h = 0.01 / metresPerUnit(geoUnit); // 1 cm in source units
  const [cx, cy] = tess.sourceCenter;
  const [a, b, c, d] = localJacobian(before, cx, cy, h);
  const [e, f, g, k] = localJacobian(after, cx, cy, h);
  const det = a * d - b * c;
  if (!Number.isFinite(det) || det === 0) return false;
  // M = J_after * J_before^-1
  const m00 = (e * d - f * c) / det, m01 = (-e * b + f * a) / det;
  const m10 = (g * d - k * c) / det, m11 = (-g * b + k * a) / det;
  const s = m00 * m00 + m01 * m01 + m10 * m10 + m11 * m11;
  const dd = m00 * m11 - m01 * m10;
  const sigmaMax = Math.sqrt((s + Math.sqrt(Math.max(0, s * s - 4 * dd * dd))) / 2);
  return Number.isFinite(sigmaMax) && tess.declaredErrorPx * sigmaMax <= budgetPx;
}
