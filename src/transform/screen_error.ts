import { DISPLAY_FIDELITY_TARGET_PX, MAX_SUBDIVISION_DEPTH } from '../config/defaults';
import type { GeoTransform } from './georeference';
import type { Camera, ProjectionAdapter } from './projection';

/** source -> calibration/georeference -> CRS -> projection -> camera -> device px */
export interface TransformPipeline {
  readonly transform: GeoTransform;
  readonly projection: ProjectionAdapter;
  readonly camera: Camera;
}

/**
 * A curve as seen across the WASM boundary. Points come from PVec's Rust evaluator; nothing in
 * this repository evaluates ISO curve mathematics in TypeScript.
 */
export interface CurveRef {
  readonly domain: readonly [number, number];
  point(t: number): [number, number];
}

/** Source point to device px through the complete pipeline. [NaN, NaN] when not projectable. */
export function sourceToDevicePx(p: TransformPipeline, x: number, y: number): [number, number] {
  const [lng, lat] = p.transform.forward(x, y);
  const [sx, sy] = p.projection.project([lng, lat], p.camera);
  const dpr = p.camera.devicePixelRatio;
  return [sx * dpr, sy * dpr];
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Interior parameters sampled per interval by chordErrorPx. */
const CHORD_SAMPLES = 7;

/**
 * Largest distance, in device px, between the transformed curve on [t0, t1] and the straight
 * screen chord between its transformed endpoints, sampled at seven interior parameters.
 * Infinity when any sample is not finite on screen.
 */
export function chordErrorPx(curve: CurveRef, t0: number, t1: number, pipeline: TransformPipeline): number {
  const [ax, ay] = sourceToDevicePx(pipeline, ...curve.point(t0));
  const [bx, by] = sourceToDevicePx(pipeline, ...curve.point(t1));
  let worst = 0;
  for (let k = 1; k <= CHORD_SAMPLES; k++) {
    const [px, py] = sourceToDevicePx(pipeline, ...curve.point(t0 + ((t1 - t0) * k) / (CHORD_SAMPLES + 1)));
    const e = distanceToSegment(px, py, ax, ay, bx, by);
    if (!Number.isFinite(e)) return Infinity;
    if (e > worst) worst = e;
  }
  return Number.isFinite(ax + ay + bx + by) ? worst : Infinity;
}

export interface SubdivisionResult {
  /** Ascending parameters, first and last are the domain ends. */
  readonly params: number[];
  /** Largest chordErrorPx over the final segments: the residual when the budget was not met. */
  readonly errorPx: number;
  /** False when the depth cap was hit with error above budget. Callers must not promote such a result. */
  readonly meetsBudget: boolean;
  readonly cappedSegments: number;
}

export function subdivide(
  curve: CurveRef,
  pipeline: TransformPipeline,
  budgetPx: number = DISPLAY_FIDELITY_TARGET_PX,
  maxDepth: number = MAX_SUBDIVISION_DEPTH,
): SubdivisionResult {
  const params: number[] = [];
  let errorPx = 0, capped = 0;
  const walk = (t0: number, t1: number, depth: number) => {
    const e = chordErrorPx(curve, t0, t1, pipeline);
    if (e <= budgetPx) {
      params.push(t0);
      if (e > errorPx) errorPx = e;
      return;
    }
    if (depth >= maxDepth) {
      params.push(t0);
      capped++;
      if (e > errorPx) errorPx = e;
      return;
    }
    const tm = (t0 + t1) / 2;
    walk(t0, tm, depth + 1);
    walk(tm, t1, depth + 1);
  };
  walk(curve.domain[0], curve.domain[1], 0);
  params.push(curve.domain[1]);
  return { params, errorPx, meetsBudget: capped === 0, cappedSegments: capped };
}

/** Measured error of a tessellation: worst distance of the curve to the polyline, over `samples` parameters. */
export function errorOfTessellation(
  params: readonly number[],
  curve: CurveRef,
  pipeline: TransformPipeline,
  samples = 10_000,
): number {
  const pts = params.map((t) => sourceToDevicePx(pipeline, ...curve.point(t)));
  const [d0, d1] = curve.domain;
  let worst = 0, seg = 0;
  for (let i = 0; i <= samples; i++) {
    const t = d0 + ((d1 - d0) * i) / samples;
    while (seg < params.length - 2 && t > params[seg + 1]!) seg++;
    const [px, py] = sourceToDevicePx(pipeline, ...curve.point(t));
    const a = pts[seg]!, b = pts[seg + 1]!;
    const e = distanceToSegment(px, py, a[0], a[1], b[0], b[1]);
    if (e > worst) worst = e;
  }
  return worst;
}
