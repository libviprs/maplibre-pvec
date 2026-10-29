/** Camera state, mirroring what MapLibre hands a custom layer (CSS px, degrees). */
export interface Camera {
  readonly center: readonly [number, number]; // lng, lat
  readonly zoom: number;
  readonly bearing: number; // degrees clockwise from north
  readonly pitch: number; // degrees, 0 = looking straight down
  readonly width: number; // CSS px
  readonly height: number; // CSS px
  readonly devicePixelRatio: number;
}

export type ScreenPoint = readonly [number, number]; // CSS px, y down
/** Row-major 2x2: [dsx/dlng, dsx/dlat, dsy/dlng, dsy/dlat] in CSS px per degree. */
export type Mat2 = readonly [number, number, number, number];
export interface LngLatBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export interface ProjectionAdapter {
  readonly id: string;
  /** lng/lat to CSS px. [NaN, NaN] when the point is behind the camera plane. */
  project(lngLat: readonly [number, number], camera: Camera): ScreenPoint;
  /** d(screen px) / d(lng, lat degrees). */
  jacobianAt(lngLat: readonly [number, number], camera: Camera): Mat2;
  /**
   * Margin in lng/lat degrees by which a polygon sampled at 16 or more segments per edge must be
   * grown so it contains the exact image of a straight screen edge lying inside `bounds`.
   */
  maxErrorInflation(bounds: LngLatBounds, camera: Camera): number;
}

/** MapLibre's vertical field of view in radians. */
export const FOV = 0.6435011087932844;
export const TILE_SIZE = 512;
/** Minimum boundary samples per screen edge assumed by maxErrorInflation. */
export const MIN_EDGE_SAMPLES = 16;

const RAD = Math.PI / 180;

export const worldSize = (zoom: number): number => TILE_SIZE * 2 ** zoom;
export const cameraToCenterDistance = (height: number): number => 0.5 / Math.tan(FOV / 2) * height;

/** Normalised web-mercator coordinates in [0, 1], y down. */
export function lngLatToMercator(lng: number, lat: number): [number, number] {
  return [(lng + 180) / 360, 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / (2 * Math.PI)];
}
export function mercatorToLngLat(x: number, y: number): [number, number] {
  return [x * 360 - 180, (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * y))) - Math.PI / 2) / RAD];
}

function wrapHalf(v: number): number {
  return v - Math.round(v);
}

/** Ground offset from the camera centre in world px, rotated into the screen frame. */
function toScreenFrame(dx: number, dy: number, bearing: number): [number, number] {
  const b = bearing * RAD, c = Math.cos(b), s = Math.sin(b);
  return [dx * c + dy * s, dx * s - dy * c]; // [right, forward]
}

export const MercatorProjectionAdapter: ProjectionAdapter = {
  id: 'mercator',

  project(lngLat, cam) {
    const [mx, my] = lngLatToMercator(lngLat[0], lngLat[1]);
    const [cx, cy] = lngLatToMercator(cam.center[0], cam.center[1]);
    const W = worldSize(cam.zoom);
    const [u, v] = toScreenFrame(wrapHalf(mx - cx) * W, (my - cy) * W, cam.bearing);
    const p = cam.pitch * RAD;
    const d = cameraToCenterDistance(cam.height);
    const depth = d + v * Math.sin(p);
    if (!(depth > 0)) return [NaN, NaN];
    return [cam.width / 2 + (u * d) / depth, cam.height / 2 - (v * Math.cos(p) * d) / depth];
  },

  jacobianAt(lngLat, cam) {
    const W = worldSize(cam.zoom);
    const phi = lngLat[1] * RAD;
    // world px per degree
    const dxdlng = W / 360;
    const dydlat = (-W / (2 * Math.PI)) * (1 / Math.cos(phi)) * RAD;
    const b = cam.bearing * RAD, cb = Math.cos(b), sb = Math.sin(b);
    const p = cam.pitch * RAD, cp = Math.cos(p), sp = Math.sin(p);
    const d = cameraToCenterDistance(cam.height);
    const [mx, my] = lngLatToMercator(lngLat[0], lngLat[1]);
    const [cx, cy] = lngLatToMercator(cam.center[0], cam.center[1]);
    const [u, v] = toScreenFrame(wrapHalf(mx - cx) * W, (my - cy) * W, cam.bearing);
    const depth = d + v * sp;
    const dsx_du = d / depth, dsx_dv = (-u * d * sp) / (depth * depth);
    const dsy_dv = (-cp * d * d) / (depth * depth);
    // (u, v) = (dx cb + dy sb, dx sb - dy cb)
    const du_dlng = cb * dxdlng, dv_dlng = sb * dxdlng;
    const du_dlat = sb * dydlat, dv_dlat = -cb * dydlat;
    return [
      dsx_du * du_dlng + dsx_dv * dv_dlng,
      dsx_du * du_dlat + dsx_dv * dv_dlat,
      dsy_dv * dv_dlng,
      dsy_dv * dv_dlat,
    ];
  },

  maxErrorInflation(bounds, cam) {
    // A straight screen edge is straight in mercator px: lng is linear along it, lat is not.
    // |d2 lat / dy2| = 2 pi^2 |sin 2 lat| (y normalised), and a chord of normalised length h
    // deviates at most h^2 / 8 times that. Edge length <= bounds diagonal, so h <= diag / 16.
    const [x0, y0] = lngLatToMercator(bounds.west, bounds.south);
    const [x1, y1] = lngLatToMercator(bounds.east, bounds.north);
    const diag = Math.hypot(x1 - x0, y1 - y0);
    const h = diag / MIN_EDGE_SAMPLES;
    const lo = Math.max(-89.9, bounds.south - 1) * RAD;
    const hi = Math.min(89.9, bounds.north + 1) * RAD;
    let s = Math.max(Math.abs(Math.sin(2 * lo)), Math.abs(Math.sin(2 * hi)));
    // 2*lat passes +-pi/2 when lat crosses +-45 degrees
    for (const q of [Math.PI / 4, -Math.PI / 4]) if (lo <= q && q <= hi) s = 1;
    void cam;
    return ((h * h) / 8) * 2 * Math.PI * Math.PI * s / RAD;
  },
};

/** Where a screen point lands on the ground plane. */
export interface GroundHit {
  readonly lngLat: [number, number];
  /** Distance along the screen's forward axis, mercator px at the camera zoom. */
  readonly forward: number;
}

/**
 * Inverse of `project` on the ground plane. Returns null at or above the horizon. When
 * `maxForward` is given, points beyond it are clamped to that forward distance at the same
 * screen azimuth (the pitch horizon clamp).
 */
export function unprojectToGround(
  sx: number,
  sy: number,
  cam: Camera,
  maxForward = Infinity,
): GroundHit | null {
  const d = cameraToCenterDistance(cam.height);
  const p = cam.pitch * RAD, cp = Math.cos(p), sp = Math.sin(p), tp = sp / cp;
  const a = (sx - cam.width / 2) / d;
  const c = -(sy - cam.height / 2) / d;
  let forward: number, depth: number;
  const k = 1 - c * tp;
  if (k > 1e-9) {
    depth = d / k;
    forward = (c * depth) / cp;
  } else {
    forward = Infinity;
    depth = Infinity;
  }
  if (forward > maxForward) {
    forward = maxForward;
    depth = d + forward * sp;
  }
  if (!Number.isFinite(forward)) return null;
  const u = a * depth;
  const b = cam.bearing * RAD, cb = Math.cos(b), sb = Math.sin(b);
  const W = worldSize(cam.zoom);
  const [cx, cy] = lngLatToMercator(cam.center[0], cam.center[1]);
  const dx = u * cb + forward * sb, dy = u * sb - forward * cb;
  // Clamp to the mercator world so a view over a pole still yields a (conservative) edge point.
  const my = Math.min(1, Math.max(0, cy + dy / W));
  return { lngLat: mercatorToLngLat(cx + dx / W, my), forward };
}

export type ProjectionCapability = 'conformant' | 'experimental' | 'unsupported';

/** Default table: Mercator is the only conformant v1 projection, globe is experimental. */
export const DEFAULT_PROJECTION_CAPABILITIES: Readonly<Record<string, ProjectionCapability>> = Object.freeze({
  mercator: 'conformant',
  globe: 'experimental',
});

/**
 * Numbered promotion criteria. A projection may be `conformant` only while every criterion's
 * test id exists and passes (checked by tests/transform/projection.test.ts).
 */
export const PROMOTION_CRITERIA = Object.freeze([
  { id: 'PC1', title: 'transform agreement', testId: 'PC1 transform agreement' },
  { id: 'PC2', title: 'jacobian-based error inflation bound', testId: 'PC2 inflation bound' },
  { id: 'PC3', title: 'deep-zoom stability', testId: 'PC3 deep-zoom stability' },
] as const);

export class UnprovenProjectionError extends Error {
  constructor(
    readonly projectionId: string,
    readonly capability: ProjectionCapability,
  ) {
    super(
      `projection "${projectionId}" is ${capability}; the Mercator conformance baseline does not ` +
        `cover it. Pass allowUnprovenProjection: true to attach anyway (results are non-conformant).`,
    );
    this.name = 'UnprovenProjectionError';
  }
}

export interface ProjectionGateResult {
  readonly capability: ProjectionCapability;
  /** True when the layer attached under allowUnprovenProjection: diagnostics and snapshots carry it. */
  readonly nonConformant: boolean;
}

/** Attach-time gate. Throws UnprovenProjectionError unless the opt-in is set. */
export function gateProjection(
  projectionId: string,
  opts: { allowUnprovenProjection?: boolean; table?: Readonly<Record<string, ProjectionCapability>> } = {},
): ProjectionGateResult {
  const capability = (opts.table ?? DEFAULT_PROJECTION_CAPABILITIES)[projectionId] ?? 'unsupported';
  if (capability === 'conformant') return { capability, nonConformant: false };
  if (!opts.allowUnprovenProjection) throw new UnprovenProjectionError(projectionId, capability);
  return { capability, nonConformant: true };
}

/** The conformance suite may only report a pass for a conformant projection. */
export function conformanceMayPass(gate: ProjectionGateResult): boolean {
  return !gate.nonConformant;
}
