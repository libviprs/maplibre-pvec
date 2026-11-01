# Rasters

A `.pvec` can carry a scan, a photo or a placed image next to its vectors (ADR 0018 in `libviprs/pvec`, ADR 0009 here). The layer draws it as textured quads through the same matrix chain as the strokes, so it lines up with the linework by construction. The browser decodes the pixels, never this package. This page is the whole subject: what the layer does with a raster, what you can set, what you see when something is refused, and what costs what. [Example 07](../examples/07-raster-underlay/main.js) puts a scan under a drawing in a few lines.

```js
import { createPVecLayer } from "maplibre-pvec";

const layer = createPVecLayer({ id: "drawing", source: { url: "http://127.0.0.1:8080/plan.pvec" }, georeference: { reference } });
layer.on("rasterskipped", (e) => console.log(e.rasterId, e.rule));
map.addLayer(layer);
await layer.whenReady();
console.log(layer.rasters()); // id, size, band, opacity, escaped attribution
layer.update({ raster: { enabled: false } }); // draws no raster and starts no decode
```

There is nothing else to configure. Band, opacity, tile size and attribution come from the file, because the producer knows what the image is. The only option is `raster.enabled`, on by default.

## How a tile gets to the screen

1. Plan. Each frame the renderer takes the placement, the georeference and the camera, picks a level (below) and lists the tiles of that level that meet the viewport. The list is computed here, with the rule `pvec-stream` plans with.
2. Prefetch hint. The list goes to the provider as a hint for the range cache. Nothing waits for it.
3. Tile call. For each tile it does not hold, the layer asks the provider for the stored bytes. The provider is the adapter over the module's raster exports: it opens the file by byte ranges, the module checks the tile (RASTER-03, LIMIT-15) and hands back the encoded bytes untouched.
4. Decode. A worker calls `createImageBitmap` and transfers the bitmap back. There is no main-thread fallback: when a worker cannot start the raster is reported, not decoded on the main thread.
5. Upload. The bitmap becomes an RGBA8 texture under the same upload budget as the strokes (4 MiB and 2 ms a frame), then the bitmap is closed.
6. Draw. Each tile is one quad. While a finer tile is on its way the coarser level's texture paints its area, as an exact sub-rectangle of the finer tile, so nothing is drawn twice and an `opacity` below 255 stays right during the swap.

## The level rule and overzoom

The level is chosen from the larger singular value of the pixel-to-device Jacobian: `k = floor(-log2 sigma)` halvings below full resolution, clamped to the pyramid. A rotated, sheared or flipped placement picks its level the same way and costs nothing extra. Beyond full resolution the level clamps and the tile magnifies (bilinear). The level never drops below one device pixel per texel in the sharper direction, so an image is not under-sampled.

## Bands and RasterId order

Band 0 draws before the strokes and band 1 after them; inside a band by `RasterId`. Hatch fills, when the engine has them, sit between. There is no interleaving of one stroke with one raster: the stroke pass is a single instanced draw. The band is the file's, so `layer.rasters()` reports it and nothing here changes it. Against MapLibre's own layers the custom layer's `beforeId` decides, as for any custom layer (`106-raster-compose.spec.ts`).

## Opacity

`opacity` is 0 to 255 per placement, multiplied into the fragment alpha, with premultiplied alpha. It is the file's, reported by `layer.rasters()`. A scan with baked transparency (a clip or a mask) needs PNG or WebP, because JPEG has no alpha (RASTER-04).

## `visible_box` and the padded edge

`visible_box` is the half-open pixel rectangle inside the image that draws; nothing outside it does, and a tile is clipped to it. The last tile of a row or column is padded by the producer. The padding colour bleeds half a texel into the visible edge through bilinear filtering, so the producer should replicate the edge into the padding.

## Attribution and escaping

A placement may carry an attribution. It is plain text, escaped by the layer (`&`, `<`, `>`, quotes) and returned by `layer.rasters()`; a custom layer has no source to carry it, so you pass it to MapLibre's control yourself, as example 07 does with `customAttribution`. Markup in an attribution reaches the control as characters and no element is made (`107-raster-hostile.spec.ts`).

## The three tiers and the two caps

Rasters use the source's three tiers: the encoded bytes after the module's checks (`compressed`), the decoded bitmaps waiting for an upload (`decoded`) and the textures (`gpu`). A texture is a `gpu` entry, so an eviction is a texture delete and `getDiagnostics().bytes.gpuTier` is the sum of the textures. Two caps bound it:

- The texture bound. Tiles in view per raster per level are at most `(ceil(W/edge)+1) * (ceil(H/edge)+1)`; the renderer counts the real tiles, doubles them for the retained coarser level, multiplies by the bytes of a texel and sums over the rasters. A raster that does not fit `cache.gpuBytes` draws from a coarser level, the one holding the most bytes first. The constants are `RASTER_DEFAULTS` (`src/config/defaults.ts`, frozen in `release/v1-freeze.json`): 4 bytes a texel, a factor of 2, the whole tier.
- `limits.maxDecodedBytes`, 256 MiB, mirrors the module's LIMIT-16 on the host side: bitmaps held or in flight never exceed it, and a plan whose tiles would not fit steps down a level.

## A skipped raster

The module refuses a raster by a rule; the layer reports it once as a `rasterskipped` event with the rule and a message, stops asking for that raster and keeps drawing the rest. The strokes and the other rasters are unchanged (a frame with a refused raster equals its raster-free twin). A tile that cannot be fetched or decoded is a missing tile, not a refusal: it is tried three times with growing waits, counted in the diagnostics, and the coarser level keeps covering it.

| rule | the module refuses when |
|---|---|
| RASTER-01 | tile edge not 256, 512 or 1024, or the pyramid does not stop at the first one-tile level |
| RASTER-02 | the index lies about its size (entry counts, offsets) |
| RASTER-03 | the tile header does not say what the placement says (size, bit depth, channels), is interlaced, animated, or has bytes after its end |
| RASTER-04 | a codec or pixel format pair the format does not allow (JPEG with alpha), or an unknown codec id |
| RASTER-05 | `pixel_to_source` is outside the bound or degenerate |
| RASTER-06 | the placements and blocks of the file disagree |
| RASTER-07 | the attribution is not plain text, or the source digest is not 32 bytes |
| LIMIT-15 | a stored tile is larger than twice an uncompressed RGBA tile plus a header allowance |
| LIMIT-16 | the plan would hand the host more decoded bytes than the cap |

## The host decoder contract

`createImageBitmap` is called with `colorSpaceConversion: "none"`, `imageOrientation: "none"` and `premultiplyAlpha: "premultiply"`, in a worker, and the bitmap is transferred back. A PNG that carries `sRGB`, `gAMA` or `iCCP` chunks is not recoloured under `none` in the engines in the grid (`docs/raster-render.md`); the producer strips colour chunks as the cover where one does. A 1-bit PNG decodes to the same RGBA as an 8-bit one. The decoder's sandbox is the defence against a hostile image, with the module's sniffers in front of it ([security](security-resource-limits.md)).

## The one-texel seam

Edge-to-edge quads have a one-texel seam with `CLAMP_TO_EDGE` and no overlap. It is accepted in v1 and written down in [deferred work](deferred.md); a producer that overlaps tiles by a texel, or a shader that insets the texture coordinate by half a texel, removes it.

## What is not drawn

- Clips as polygons. A clip is baked into the pixels (alpha) by the producer.
- Per-entity interleaving of rasters with strokes. There are two bands.
- A `projective` georeference for a raster. One affine per raster, in the file; the layer's georeference may be projective for the strokes, not for rasters in v1.
- A raster through MapLibre's own raster source (`pvec-raster://`). Rejected in ADR 0009: it only works for an axis-aligned placement on MapLibre's grid.

## Measured costs

Display-fidelity and frame-behaviour numbers, each with the renderer, engine and arch that produced it. The full tables are in the [benchmark report](benchmark-report.md); software GL rows are relative costs and are never a budget.

RASTER_NUMBERS_TABLE
