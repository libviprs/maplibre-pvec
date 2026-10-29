import { sourceToWorld } from '../../../src/transform/rebase';
import { anchoredGeoRef, transformOf } from './scene';
import { type Scheme, type WorldCamera, emulate, maxErrorPx, truth } from './f32';
import { rng } from './rng';

export interface CellParams {
  zoom: number;
  magnitude: number; // source units from the anchor (mm)
  size: number; // feature size in source units
  lat: number;
  rotationDeg: number;
  bearing: number;
  pitch: number;
  dpr: number;
  /** Half-extent of the block around the feature, in source units. Default 5e4 (50 m of mm). */
  spread?: number;
}

/**
 * One matrix cell: a small feature (size) at `magnitude` source mm from the calibration anchor,
 * inside a 100 m block with spread vertices, viewed from a camera that has the feature on screen.
 */
export function cellVertices(c: CellParams, seed: number) {
  const r = rng(seed);
  const t = transformOf(anchoredGeoRef({ lng: 8.5, lat: c.lat, rotationDeg: c.rotationDeg, unit: 'mm' }));
  const a = r() * Math.PI * 2;
  const sx = c.magnitude * Math.cos(a), sy = c.magnitude * Math.sin(a);
  const pts: number[] = [];
  const feature: number[] = [];
  for (let i = 0; i < 4; i++) {
    const b = (i / 4) * Math.PI * 2 + r();
    feature.push(sx + c.size * Math.cos(b), sy + c.size * Math.sin(b));
  }
  const spread: number[] = [];
  for (let i = 0; i < 4; i++) spread.push(sx + (r() * 2 - 1) * (c.spread ?? 5e4), sy + (r() * 2 - 1) * (c.spread ?? 5e4));
  for (const v of [...feature, ...spread]) pts.push(v);
  const world = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) [world[i]!, world[i + 1]!] = sourceToWorld(t, pts[i]!, pts[i + 1]!);
  // camera centred near the first feature vertex, offset by up to 200 px
  const W = 512 * 2 ** c.zoom;
  const cam: WorldCamera = {
    cx: world[0]! + ((r() * 2 - 1) * 200) / W,
    cy: world[1]! + ((r() * 2 - 1) * 200) / W,
    zoom: c.zoom, bearing: c.bearing, pitch: c.pitch, width: 1024, height: 768, dpr: c.dpr,
  };
  return { world, cam };
}

export function cellError(c: CellParams, scheme: Scheme, seed = 1): number {
  const { world, cam } = cellVertices(c, seed);
  return maxErrorPx(emulate(scheme, world, cam), truth(world, cam), cam);
}
