import { type LocalOrigin, buildBlockPositions, cameraRelativeOrigin, chooseLocalOrigin } from '../../../src/transform/origin';
import { FOV } from '../../../src/transform/projection';

/** Camera in f64 normalised-mercator world coordinates (the shader's frame of reference). */
export interface WorldCamera {
  cx: number;
  cy: number;
  zoom: number;
  bearing: number;
  pitch: number;
  width: number;
  height: number;
  dpr: number;
}

const RAD = Math.PI / 180;
const id = (v: number) => v;

/**
 * Normalised world offset from the camera (dx, dy) to device px. With `f32` every arithmetic
 * result is rounded to single precision, emulating the vertex shader after reconstruction.
 */
export function offsetToDevicePx(dx: number, dy: number, cam: WorldCamera, f32: boolean): [number, number] {
  const r = f32 ? Math.fround : id;
  const W = r(512 * 2 ** cam.zoom);
  const b = cam.bearing * RAD, p = cam.pitch * RAD;
  const cb = r(Math.cos(b)), sb = r(Math.sin(b)), cp = r(Math.cos(p)), sp = r(Math.sin(p));
  const d = r((0.5 / Math.tan(FOV / 2)) * cam.height);
  const px = r(dx * W), py = r(dy * W);
  const u = r(r(px * cb) + r(py * sb));
  const v = r(r(px * sb) - r(py * cb));
  const depth = r(d + r(v * sp));
  const sx = r(cam.width / 2 + r(r(u * d) / depth));
  const sy = r(cam.height / 2 - r(r(r(v * cp) * d) / depth));
  return [sx * cam.dpr, sy * cam.dpr];
}

export type Scheme = 'naive' | 'origin' | 'highlow';

/** Device px of world vertices under each GPU coordinate scheme, emulating f32 shader math. */
export function emulate(scheme: Scheme, worldXY: Float64Array, cam: WorldCamera): Float64Array {
  const n = worldXY.length >> 1;
  const out = new Float64Array(2 * n);
  const f = Math.fround;
  if (scheme === 'naive') {
    for (let i = 0; i < n; i++) {
      const dx = f(f(worldXY[2 * i]!) - f(cam.cx)), dy = f(f(worldXY[2 * i + 1]!) - f(cam.cy));
      [out[2 * i]!, out[2 * i + 1]!] = offsetToDevicePx(dx, dy, cam, true);
    }
    return out;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, worldXY[2 * i]!); maxX = Math.max(maxX, worldXY[2 * i]!);
    minY = Math.min(minY, worldXY[2 * i + 1]!); maxY = Math.max(maxY, worldXY[2 * i + 1]!);
  }
  const origin: LocalOrigin = chooseLocalOrigin(minX, minY, maxX, maxY);
  return emulateWithOrigin(scheme, worldXY, origin, cam);
}

export function emulateWithOrigin(scheme: 'origin' | 'highlow', worldXY: Float64Array, origin: LocalOrigin, cam: WorldCamera): Float64Array {
  const n = worldXY.length >> 1;
  const out = new Float64Array(2 * n);
  const f = Math.fround;
  const { hi, lo } = buildBlockPositions(worldXY, origin);
  const u = cameraRelativeOrigin(origin, cam.cx, cam.cy); // [hiX, hiY, loX, loY]
  for (let i = 0; i < n; i++) {
    let dx: number, dy: number;
    if (scheme === 'origin') {
      // local origin only: one f32 offset per vertex, one f32 camera-relative origin per block
      dx = f(hi[2 * i]! - u[0]!);
      dy = f(hi[2 * i + 1]! - u[1]!);
    } else {
      dx = f(f(hi[2 * i]! - u[0]!) + f(lo[2 * i]! - u[2]!));
      dy = f(f(hi[2 * i + 1]! - u[1]!) + f(lo[2 * i + 1]! - u[3]!));
    }
    [out[2 * i]!, out[2 * i + 1]!] = offsetToDevicePx(dx, dy, cam, true);
  }
  return out;
}

/** f64 ground truth for the same vertices and camera. */
export function truth(worldXY: Float64Array, cam: WorldCamera): Float64Array {
  const n = worldXY.length >> 1;
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    [out[2 * i]!, out[2 * i + 1]!] = offsetToDevicePx(worldXY[2 * i]! - cam.cx, worldXY[2 * i + 1]! - cam.cy, cam, false);
  }
  return out;
}

export function maxErrorPx(a: Float64Array, b: Float64Array, cam: WorldCamera): number {
  let worst = 0;
  const w = cam.width * cam.dpr, h = cam.height * cam.dpr;
  for (let i = 0; i < a.length; i += 2) {
    // only vertices near the viewport matter
    if (b[i]! < -w || b[i]! > 2 * w || b[i + 1]! < -h || b[i + 1]! > 2 * h) continue;
    worst = Math.max(worst, Math.hypot(a[i]! - b[i]!, a[i + 1]! - b[i + 1]!));
  }
  return worst;
}
