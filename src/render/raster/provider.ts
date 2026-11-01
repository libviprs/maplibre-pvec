import type { RasterPlacement, TileId } from "./geometry";

/**
 * What the renderer needs from a PVec file's raster stream. The wasm adapter over the pvec-wasm exports (libviprs/pvec#221)
 * implements it; the tests implement it over a synthetic pyramid. This is the seam: the renderer never sees a handle, a
 * range or an ABI version.
 */
export interface RasterProvider {
  /** Every raster the file carries, in RasterId order. */
  placements(): readonly RasterPlacement[];
  /** Rasters the module refused, each with the RASTER-NN rule it names. They are not in `placements()`. Optional. */
  skipped?(): readonly { id: number; rule: string; message: string }[];
  /** The tiles a plan needs, as a prefetch hint for the host's range cache. Optional, never awaited. */
  hint?(id: number, level: number, tiles: readonly TileId[]): void;
  /** The encoded bytes of one tile after the index checksum, or null when the tile is not stored. Rejects on a failed read. */
  tile(id: number, level: number, col: number, row: number): Promise<Uint8Array | null>;
  /** Set when the module refused the raster stream as a whole (a rule on the stream, such as RASTER-04 for JPEG under an RGBA placement): there are no placements. */
  refusedStream?: { rule: string; message: string };
  /** Called once when the layer goes away. */
  release?(): void;
}

/**
 * What a provider's `tile()` rejects with when the module refused the raster by a rule (a failed sniffer, a limit): the rule is
 * `RASTER-NN` or `LIMIT-NN`. The layer reports it once as `rasterskipped`, stops asking for that raster and keeps drawing the rest.
 * Any other rejection is a tile that could not be had, which is a missing tile.
 */
export class RasterRefusedError extends Error {
  constructor(readonly rule: string, message: string) {
    super(message);
    this.name = "RasterRefusedError";
  }
}
