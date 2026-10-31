import { RASTER_DEFAULTS } from "../../config/defaults";
import { chooseLevel, tilesInView, type RasterPlacement, type RasterView, type TileId } from "./geometry";

/** Bytes one tile occupies as a texture: always RGBA8, no mipmaps (the pyramid is the mip chain). */
export const tileTextureBytes = (edge: number): number => edge * edge * RASTER_DEFAULTS.bytesPerTexel;

export interface FittedRaster {
  id: number;
  /** The level the rule wants. */
  wanted: number;
  /** The level that fits the gpu tier. */
  level: number;
  tiles: TileId[];
}

/**
 * The texture bound as a formula, applied (constants in `RASTER_DEFAULTS`): tiles in view per raster per level, times two for the retained coarser
 * level, times the tile's bytes, summed over the rasters drawn, must fit the gpu tier. A raster that does not fit
 * draws from a coarser level; the one holding the most bytes steps down first. A raster at its coarsest level stays
 * there, so the loop ends.
 */
export function fitLevels(ps: readonly RasterPlacement[], v: RasterView, gpuBytes: number): FittedRaster[] {
  const out = ps.map((p): FittedRaster => {
    const wanted = chooseLevel(p, v);
    return { id: p.id, wanted, level: wanted, tiles: tilesInView(p, v, wanted) };
  });
  const bytes = (i: number) => out[i]!.tiles.length * RASTER_DEFAULTS.retainedLevelFactor * tileTextureBytes(ps[i]!.tileEdge);
  for (;;) {
    let total = 0, worst = -1;
    for (let i = 0; i < out.length; i++) {
      total += bytes(i);
      if (out[i]!.level > 0 && (worst < 0 || bytes(i) > bytes(worst))) worst = i;
    }
    if (total <= gpuBytes * RASTER_DEFAULTS.textureShare || worst < 0) return out;
    const r = out[worst]!;
    r.level -= 1;
    r.tiles = tilesInView(ps[worst]!, v, r.level);
  }
}

/**
 * LIMIT-16 on the host side, as pvec's plan applies it: the tiles of all the rasters' plans, decoded, must fit in `maxDecoded`.
 * The raster holding the most bytes steps down a level first, until it fits or every raster sits at level 0. The plan is
 * changed in place.
 */
export function limitDecoded(fits: Map<number, FittedRaster>, ps: readonly RasterPlacement[], views: Map<number, RasterView>, maxDecoded: number): void {
  const bytes = (p: RasterPlacement) => (fits.get(p.id)?.tiles.length ?? 0) * tileTextureBytes(p.tileEdge);
  for (;;) {
    let total = 0, worst: RasterPlacement | undefined;
    for (const p of ps) {
      total += bytes(p);
      if ((fits.get(p.id)?.level ?? 0) > 0 && (!worst || bytes(p) > bytes(worst))) worst = p;
    }
    if (total <= maxDecoded || !worst) return;
    const f = fits.get(worst.id)!;
    f.level -= 1;
    f.tiles = tilesInView(worst, views.get(worst.id)!, f.level);
  }
}

/**
 * Takes the uploads one frame may do from the head of `queue`: at least one, then until the byte or the millisecond
 * budget is spent (the rule of `BufferPool.flush`).
 */
export function takeUploads<T extends { bytes: number }>(queue: T[], o: { budgetBytes: number; budgetMs: number; now: () => number }): T[] {
  const start = o.now();
  const taken: T[] = [];
  let sent = 0;
  while (queue.length) {
    if (sent > 0 && (sent >= o.budgetBytes || o.now() - start >= o.budgetMs)) break;
    const u = queue.shift()!;
    taken.push(u);
    sent += u.bytes;
  }
  return taken;
}
