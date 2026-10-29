import { DEFAULTS } from '../../config/defaults';

export type JoinStyle = 'miter' | 'bevel' | 'round';
export type CapStyle = 'butt' | 'square' | 'round';
export interface StrokeOptions { width: number; join: JoinStyle; cap: CapStyle; miterLimit?: number }
export interface JoinPart { pointIndex: number; kind: 'miter' | 'bevel' | 'round'; vertices: Float32Array }
export interface CapPart { pointIndex: number; vertices: Float32Array }
export interface StrokeMesh {
  /** Triangle list, x,y pairs. */
  positions: Float32Array;
  joins: JoinPart[];
  caps: CapPart[];
}

const ARC_STEP = Math.PI / 12;

/**
 * CPU reference of the stroke geometry the vertex shader expands from the segment records.
 * It is the oracle for join, cap and miter-limit behaviour and is exact in f64 before
 * the f32 conversion at the end.
 */
export function buildStrokeMesh(points: ArrayLike<number>, o: StrokeOptions): StrokeMesh {
  const hw = o.width / 2;
  const limit = o.miterLimit ?? DEFAULTS.miterLimit;
  // drop degenerate points
  const p: number[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i]!, y = points[i + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (p.length && x === p[p.length - 2] && y === p[p.length - 1]) continue;
    p.push(x, y);
  }
  const tri: number[] = [];
  const joins: JoinPart[] = [], caps: CapPart[] = [];
  const n = p.length / 2;
  if (n < 2) return { positions: new Float32Array(0), joins, caps };
  const dirs: Array<[number, number]> = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = p[2 * i + 2]! - p[2 * i]!, dy = p[2 * i + 3]! - p[2 * i + 1]!, l = Math.hypot(dx, dy);
    dirs.push([dx / l, dy / l]);
  }
  const quad = (a: number[], b: number[], c: number[], d: number[]) => tri.push(...a, ...b, ...c, ...a, ...c, ...d);
  const fan = (cx: number, cy: number, v: number[]) => { for (let i = 0; i + 3 < v.length; i += 2) tri.push(cx, cy, v[i]!, v[i + 1]!, v[i + 2]!, v[i + 3]!); };

  for (let i = 0; i < n - 1; i++) {
    const [dx, dy] = dirs[i]!;
    const nx = -dy * hw, ny = dx * hw;
    const x0 = p[2 * i]!, y0 = p[2 * i + 1]!, x1 = p[2 * i + 2]!, y1 = p[2 * i + 3]!;
    quad([x0 + nx, y0 + ny], [x0 - nx, y0 - ny], [x1 - nx, y1 - ny], [x1 + nx, y1 + ny]);
  }

  for (let i = 1; i < n - 1; i++) {
    const [ax, ay] = dirs[i - 1]!, [bx, by] = dirs[i]!;
    const cross = ax * by - ay * bx, dot = ax * bx + ay * by;
    const jx = p[2 * i]!, jy = p[2 * i + 1]!;
    if (Math.abs(cross) < 1e-12 && dot > 0) continue; // collinear
    // outer side is opposite the turn
    const s = cross > 0 ? -1 : 1;
    const o1 = [jx + s * -ay * hw, jy + s * ax * hw];
    const o2 = [jx + s * -by * hw, jy + s * bx * hw];
    // interior angle between the segments is pi - turn; miter ratio = 1 / sin(interior / 2) = 1 / cos(turn / 2)
    const cosHalfTurn = Math.sqrt(Math.max(0, (1 + dot) / 2));
    const ratio = cosHalfTurn > 1e-12 ? 1 / cosHalfTurn : Infinity;
    if (o.join === 'round') {
      const a0 = Math.atan2(o1[1]! - jy, o1[0]! - jx);
      let da = Math.atan2(o2[1]! - jy, o2[0]! - jx) - a0;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const steps = Math.max(1, Math.ceil(Math.abs(da) / ARC_STEP));
      const v: number[] = [];
      for (let k = 0; k <= steps; k++) { const a = a0 + (da * k) / steps; v.push(jx + Math.cos(a) * hw, jy + Math.sin(a) * hw); }
      fan(jx, jy, v);
      joins.push({ pointIndex: i, kind: 'round', vertices: Float32Array.from(v) });
    } else if (o.join === 'miter' && ratio <= limit) {
      const mx = o1[0]! + o2[0]! - 2 * jx, my = o1[1]! + o2[1]! - 2 * jy;
      const ml = Math.hypot(mx, my);
      const tip = [jx + (mx / ml) * hw * ratio, jy + (my / ml) * hw * ratio];
      tri.push(jx, jy, o1[0]!, o1[1]!, tip[0]!, tip[1]!, jx, jy, tip[0]!, tip[1]!, o2[0]!, o2[1]!);
      joins.push({ pointIndex: i, kind: 'miter', vertices: Float32Array.from([o1[0]!, o1[1]!, tip[0]!, tip[1]!, o2[0]!, o2[1]!]) });
    } else {
      tri.push(jx, jy, o1[0]!, o1[1]!, o2[0]!, o2[1]!);
      joins.push({ pointIndex: i, kind: 'bevel', vertices: Float32Array.from([o1[0]!, o1[1]!, o2[0]!, o2[1]!]) });
    }
  }

  const addCap = (i: number, dx: number, dy: number) => {
    if (o.cap === 'butt') return;
    const x = p[2 * i]!, y = p[2 * i + 1]!, nx = -dy * hw, ny = dx * hw;
    if (o.cap === 'square') {
      quad([x + nx, y + ny], [x - nx, y - ny], [x - nx + dx * hw, y - ny + dy * hw], [x + nx + dx * hw, y + ny + dy * hw]);
      caps.push({ pointIndex: i, vertices: Float32Array.from([x + nx + dx * hw, y + ny + dy * hw, x - nx + dx * hw, y - ny + dy * hw]) });
      return;
    }
    const a0 = Math.atan2(ny, nx);
    const steps = Math.ceil(Math.PI / ARC_STEP);
    const v: number[] = [];
    for (let k = 0; k <= steps; k++) { const a = a0 - (Math.PI * k) / steps; v.push(x + Math.cos(a) * hw, y + Math.sin(a) * hw); }
    fan(x, y, v);
    caps.push({ pointIndex: i, vertices: Float32Array.from(v) });
  };
  addCap(0, -dirs[0]![0], -dirs[0]![1]);
  addCap(n - 1, dirs[n - 2]![0], dirs[n - 2]![1]);
  return { positions: Float32Array.from(tri), joins, caps };
}
