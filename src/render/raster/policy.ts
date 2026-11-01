import type { RasterPlacement } from "./geometry";

/** Band 0 rasters draw before the hatch fills and strokes, band 1 after; inside a band by `RasterId`. */
export function drawOrder(ps: readonly RasterPlacement[]): { under: RasterPlacement[]; over: RasterPlacement[] } {
  const byId = [...ps].sort((a, b) => a.id - b.id);
  return { under: byId.filter((p) => p.band === 0), over: byId.filter((p) => p.band === 1) };
}

export type SkipReason = "unknown-codec" | "jpeg-with-alpha";
/** Both skips of this reader fall under RASTER-04 (RASTER.md): the codec id and pixel format pair is not one it can draw. */
export const SKIP_TEXT: Record<SkipReason, { rule: string; message: string }> = {
  "unknown-codec": { rule: "RASTER-04", message: "unknown codec id: the raster is skipped and the rest of the file draws" },
  "jpeg-with-alpha": { rule: "RASTER-04", message: "a JPEG with an alpha channel is not a pair the format allows: the raster is skipped" },
};
export const KNOWN_CODECS: ReadonlySet<number> = new Set([1, 2, 3]);

/** The rasters this reader can draw, and the ones it skips with the reason (the `Unrastered` stat). */
export function classifyRasters(ps: readonly RasterPlacement[], refused: ReadonlySet<number> = new Set()): { drawable: RasterPlacement[]; unrastered: { id: number; reason: SkipReason }[] } {
  const drawable: RasterPlacement[] = [];
  const unrastered: { id: number; reason: SkipReason }[] = [];
  for (const p of ps) {
    if (refused.has(p.id)) continue;
    if (!KNOWN_CODECS.has(p.codec)) unrastered.push({ id: p.id, reason: "unknown-codec" });
    else if (p.codec === 2 && (p.channels === 2 || p.channels === 4)) unrastered.push({ id: p.id, reason: "jpeg-with-alpha" });
    else drawable.push(p);
  }
  return { drawable, unrastered };
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Plain text to an HTML-safe string, for MapLibre's attribution control, which takes markup. */
export const escapeAttribution = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);
