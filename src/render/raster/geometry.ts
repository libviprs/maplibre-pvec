/**
 * The geometry of a PVec raster (ADR 0018, ADR 0009 here): the level rule, the tiles a view needs and the quad each
 * tile draws. Pure functions over numbers, so the same code runs in the layer and in the unit tests, and the level rule
 * is the one `pvec-stream` plans with (libviprs/pvec#220).
 */

/** `[a b c d tx ty]` with `x' = a*x + b*y + tx` and `y' = c*x + d*y + ty`: PVec's `Transform2` order. */
export type Mat6 = readonly [number, number, number, number, number, number];

export interface RasterPlacement {
  id: number;
  /** Full-resolution pixel (origin at the top-left corner of pixel (0,0), y down) to PVec source space. */
  pixelToSource: Mat6;
  width: number;
  height: number;
  /** Half-open pixel rectangle `[x0, y0, x1, y1]` inside `width` by `height`: the only area that draws. */
  visibleBox: readonly [number, number, number, number];
  tileEdge: number;
  levels: number;
  /** 1 PNG, 2 JPEG, 3 WebP. */
  codec: number;
  channels: 1 | 2 | 3 | 4;
  bitDepth: 1 | 8;
  /** 0 to 255, multiplied into the fragment alpha. */
  opacity: number;
  /** 0 draws before the hatch fills and strokes, 1 after. */
  band: 0 | 1;
  attribution?: string;
}

/** Source space to device pixels over a viewport of `width` by `height` device pixels, as an affine around the raster. */
export interface RasterView {
  sourceToDevice: Mat6;
  width: number;
  height: number;
}

export interface TileId {
  col: number;
  row: number;
}

/** `a` after `b`: the map that applies `b` first. */
export function compose(a: Mat6, b: Mat6): Mat6 {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[0] * b[4] + a[1] * b[5] + a[4],
    a[2] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function invert(m: Mat6): Mat6 | undefined {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || det === 0) return undefined;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + b * m[5]), -(c * m[4] + d * m[5])];
}

export const apply = (m: Mat6, x: number, y: number): [number, number] => [m[0] * x + m[1] * y + m[4], m[2] * x + m[3] * y + m[5]];

/** sigma_max of the linear part, from the closed form `s^2 = (E + sqrt(E^2 - 4 det^2)) / 2` with `E` the squared Frobenius norm. */
export function largestSingularValue(m: Mat6): number {
  const e = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] + m[3] * m[3];
  const det = m[0] * m[3] - m[1] * m[2];
  return Math.sqrt((e + Math.sqrt(Math.max(0, e * e - 4 * det * det))) / 2);
}

/** Pixel to device for a placement in a view. */
export const pixelToDevice = (p: RasterPlacement, v: RasterView): Mat6 => compose(v.sourceToDevice, p.pixelToSource);

/** Halvings between a level and full resolution: level `levels - 1` is full resolution. */
export const halvings = (p: RasterPlacement, level: number): number => p.levels - 1 - level;

/**
 * The level whose texels are still at least one device pixel in the sharper direction of the Jacobian, so the image
 * is never under-sampled. Beyond full resolution the level clamps and the tile magnifies.
 */
export function chooseLevel(p: RasterPlacement, v: RasterView): number {
  const s = largestSingularValue(pixelToDevice(p, v));
  if (!(s > 0)) return 0;
  const k = Math.min(p.levels - 1, Math.max(0, Math.floor(-Math.log2(s))));
  return p.levels - 1 - k;
}

/** Tiles in view per raster per level, at most (ceil(W/edge)+1) * (ceil(H/edge)+1). */
export const tileBound = (w: number, h: number, edge: number): number => (Math.ceil(w / edge) + 1) * (Math.ceil(h / edge) + 1);

/** A tile's rectangle in full-resolution pixels (clipped to `visible_box`) and the texture coordinates of its corners. */
export interface TileQuad {
  px: [number, number, number, number];
  uv: [number, number, number, number];
}

export function tileQuad(p: RasterPlacement, level: number, col: number, row: number): TileQuad | undefined {
  const span = p.tileEdge * 2 ** halvings(p, level);
  return textureUv(p, level, col, row, [col * span, row * span, (col + 1) * span, (row + 1) * span]);
}

/**
 * The part of full-resolution rectangle `rect` that the texture of tile (`col`, `row`) of `level` can paint, clipped to
 * `visible_box`, with the texture coordinates of its corners. A coarser level paints a finer tile's area this way while
 * the finer tile is still on its way.
 */
export function textureUv(p: RasterPlacement, level: number, col: number, row: number, rect: readonly [number, number, number, number]): TileQuad | undefined {
  const f = 2 ** halvings(p, level);
  const span = p.tileEdge * f;
  const x0 = Math.max(col * span, p.visibleBox[0], rect[0]), x1 = Math.min((col + 1) * span, p.visibleBox[2], rect[2]);
  const y0 = Math.max(row * span, p.visibleBox[1], rect[1]), y1 = Math.min((row + 1) * span, p.visibleBox[3], rect[3]);
  if (!(x1 > x0 && y1 > y0)) return undefined;
  const u = (x: number) => (x / f - col * p.tileEdge) / p.tileEdge;
  const w = (y: number) => (y / f - row * p.tileEdge) / p.tileEdge;
  return { px: [x0, y0, x1, y1], uv: [u(x0), w(y0), u(x1), w(y1)] };
}

/** Separating axis test of two convex polygons given as flat x,y lists. */
function overlaps(a: readonly number[], b: readonly number[]): boolean {
  for (const poly of [a, b]) {
    const n = poly.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = -(poly[j * 2 + 1]! - poly[i * 2 + 1]!), ay = poly[j * 2]! - poly[i * 2]!;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (let k = 0; k < a.length; k += 2) { const d = a[k]! * ax + a[k + 1]! * ay; if (d < amin) amin = d; if (d > amax) amax = d; }
      for (let k = 0; k < b.length; k += 2) { const d = b[k]! * ax + b[k + 1]! * ay; if (d < bmin) bmin = d; if (d > bmax) bmax = d; }
      if (amax < bmin || bmax < amin) return false;
    }
  }
  return true;
}

/**
 * The tiles of `level` the view needs, row-major. The four viewport corners go through the inverse placement and the
 * pixel box of the result bounds the candidates (the same over-fetch pvec-stream plans); `cull` then drops the ones
 * whose quad misses the viewport polygon. There is no winding test: `d < 0` is the normal upright image.
 */
export function tilesInView(p: RasterPlacement, v: RasterView, level: number, o: { cull?: boolean } = {}): TileId[] {
  const m = pixelToDevice(p, v);
  const inv = invert(m);
  if (!inv) return [];
  const f = 2 ** halvings(p, level);
  const span = p.tileEdge * f;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [cx, cy] of [[0, 0], [v.width, 0], [v.width, v.height], [0, v.height]] as const) {
    const [px, py] = apply(inv, cx, cy);
    x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
  }
  if (![x0, y0, x1, y1].every(Number.isFinite)) return [];
  const cols = Math.ceil(Math.ceil(p.width / f) / p.tileEdge), rows = Math.ceil(Math.ceil(p.height / f) / p.tileEdge);
  const c0 = Math.max(0, Math.floor(Math.max(x0, p.visibleBox[0]) / span)), c1 = Math.min(cols - 1, Math.floor(Math.min(x1, p.visibleBox[2] - 1e-9) / span));
  const r0 = Math.max(0, Math.floor(Math.max(y0, p.visibleBox[1]) / span)), r1 = Math.min(rows - 1, Math.floor(Math.min(y1, p.visibleBox[3] - 1e-9) / span));
  const view = [0, 0, v.width, 0, v.width, v.height, 0, v.height];
  const out: TileId[] = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const q = tileQuad(p, level, col, row);
      if (!q) continue;
      if (o.cull !== false) {
        const poly: number[] = [];
        for (const [x, y] of [[q.px[0], q.px[1]], [q.px[2], q.px[1]], [q.px[2], q.px[3]], [q.px[0], q.px[3]]] as const) poly.push(...apply(m, x, y));
        if (!overlaps(poly, view)) continue;
      }
      out.push({ col, row });
    }
  }
  return out;
}
