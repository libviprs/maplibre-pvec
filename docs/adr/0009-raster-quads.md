# ADR 0009: Rasters are textured quads in the custom layer

- Status: Accepted, 2026-10-31
- Date: 2026-10-31
- Evidence: `docs/raster-render.md`, `release/evidence/102-raster.json`

## Context

ADR 0018 in `libviprs/pvec` lets a PVec artifact carry raster tiles next to the vectors: a placement (six `f64` for pixel to source, a pixel `visible_box`, a tile edge of 256, 512 or 1024, a band and an opacity), an index and tile blocks. This repository has to draw them. It already has one matrix chain with a hi/lo position split for the strokes (ADR 0001, ADR 0002), a worker model that keeps the main thread under 1 ms a frame (ADR 0005), a `gpu` tier in `TieredCache` and an upload budget (4 MiB and 2 ms a frame).

## Decision

**The quad path.** Each visible tile is one textured quad through the same chain as the strokes. The four corners go pixel to source (the placement), source to world (the georeference, in f64), then hi/lo split, and the vertex shader subtracts the camera in two steps exactly as `position.glsl` does. The interior is bilinear. A rotated, sheared or flipped placement costs nothing extra, and the image lines up with the linework because both ride the same georeference. Mercator curvature over one tile is far below a pixel, and a `projective` calibration is out of scope for raster in v1.

**No winding cull.** Source space is y-up, so an upright image has `d < 0` and a negative determinant. `CULL_FACE` is never enabled by the raster pass, and a test counts the calls.

**Draw order.** Band 0 rasters, then the strokes (hatch fills are not in the engine yet and will sit between), then band 1 rasters. Inside a band by `RasterId`. There is no interleaving with strokes in v1, because the stroke pass is one instanced draw. A coarser level's texture paints a finer tile's area while that tile is on its way, as an exact sub-rectangle of the finer tile, so nothing is drawn twice and an `opacity` below 255 stays correct during the swap.

**Level rule.** The same rule `pvec-stream` plans with: the larger singular value of the pixel-to-device Jacobian, `k = floor(-log2 sigma)` halvings below full resolution, clamped to the pyramid. Beyond full resolution the level clamps and the tile magnifies. The smaller singular value, the determinant root and the Frobenius norm each pick another level on the unit test vector, so the test tells the rules apart. The renderer computes the level and the tile list itself and hands the list to the provider as a prefetch hint; the vector is shared with `pvec`'s `issue_220_raster_plan.rs` so the two cannot drift without a red test on one side.

**Budget.** Tiles in view per raster per level are at most `(ceil(W/edge)+1) * (ceil(H/edge)+1)` (20 at 1080p and 54 at 4K with 512 px tiles). The renderer counts the real tiles, doubles them for the retained coarser level, multiplies by the tile's bytes (RGBA8, `edge * edge * 4`, no mipmaps) and sums over the rasters. A raster that does not fit the `gpu` tier steps down a level, the one holding the most bytes first, until it fits or sits at level 0. The constant (bytes per tile) and the measured decode times are in `docs/raster-render.md`.

**Render budget.** Main-thread time inside `layer.render` on frames that upload no tile is at most 1.5 ms at the 95th percentile on every real renderer, integrated GPUs included; where the timer resolves 1 ms or coarser (WebKit) the mean is asserted instead. Frames that upload a tile are governed by the frozen upload budget (4 MiB and 2 ms) and one rule: no frame that uploads a tile takes longer than one 60 fps frame (16.7 ms), and no frame uploads more than the byte budget plus one tile. The p95, the count, the maximum and every upload frame over 16.7 ms are recorded in the result and not asserted. The increment over the stroke scene alone, the share of upload frames and every software GL number are recorded and not budgeted. ADR 0005's 1 ms stays the pipeline's number.

**Tile cache.** Textures are entries of the source's `gpu` tier, keyed `rID/level/col/row`, so the diagnostics' `gpuTier` is the sum of the raster textures and an eviction by the tier is a texture delete (the renderer reconciles after every `put`). Marking the tiles of the frame visible uses `setVisible`, which replaces the visible set of every tier; nothing else marks entries visible today, and whoever adds a second user has to give `setVisible` a merge.

**Decode in the host, not in MapLibre.** The bytes of a tile come from the provider (the seam below), go to a worker that runs `createImageBitmap` with colour-space conversion off, orientation `none` and premultiplied alpha, and the `ImageBitmap` is transferred back and uploaded under the upload budget, then closed. There is no main-thread fallback: a worker that cannot start leaves the raster undecoded and reports an error. A 1-bit PNG decodes to the same RGBA the 8-bit ones do.

**Rejected: a `pvec-raster://` protocol for MapLibre's raster source.** MapLibre would own decode, cache and draw, which is less code here. It only works for a placement that is axis aligned and on MapLibre's tile grid in the drawing's synthetic world, and no libviprs pyramid is today (ADR 0018, Context). It also puts the raster in a style layer, so band 0 and band 1 around the custom layer's strokes would need two `beforeId` positions and the georeference would be wired twice. It stays a later adapter for the aligned case.

**The seam.** The renderer sees a `RasterProvider`: the placements, an optional prefetch hint and `tile(id, level, col, row)`. The adapter over the `pvec-wasm` raster exports (`libviprs/pvec#221`) implements it and `EngineDeps.openRasters` returns it; until the exports exist the default returns `null` and the layer draws exactly as before. A module without the exports, and a file without a raster stream, change nothing in the render loop.

**Guard.** Everything GL of the raster pass runs inside `GlStateGuard.run`, uses texture unit 0 and one program, and never reads GL state back: the guard keeps a shadow, and a test counts `getParameter` and `isEnabled` calls over ten frames with rasters.

**Skipped rasters.** An unknown codec, or a JPEG with an alpha channel, is skipped and reported once through the existing `capabilityunsupported` event with capability `raster`. The `DiagnosticsSnapshot` is frozen with the v1 API report, and a new field there changes a symbol hash (a `major` under `classifyApiChange`), so the count is not added to it in this change. Adding it is a freeze amendment for Rom to approve.

## Accepted costs

- Edge-to-edge quads have a one-texel seam with `CLAMP_TO_EDGE` and no overlap. Recorded in `docs/deferred.md`.
- A padded edge tile bleeds its padding colour half a texel into the visible edge through bilinear filtering; the producer should replicate the edge into the padding.
- `attribution` is escaped by `escapeAttribution` and exposed by the renderer, but nothing yet puts it into MapLibre's attribution control: a custom layer has no source to carry it, and the way in (a companion source with an empty layer) needs a style mutation I did not want to decide without a placement that carries one. Recorded in `docs/deferred.md`.

## Consequences

- The texture bound is a formula with a measured constant, and a view that does not fit draws coarser instead of failing.
- ADR 0018's open question 5 on the renderer side is answered by `docs/raster-render.md`; a dated pointer goes into that ADR in `libviprs/pvec`.
- 2026-10-31, the render budget: #108 and the epic asked for under 1 ms at p95 with decodes running. On the Intel ADL GT2 part that cannot be met by construction: the p95 of all frames sits on the seam between steady frames and the 5 to 7 percent of frames that upload a tile (which cost a 1 MiB `texImage2D` on top), the upload is already budgeted by the frozen 2 ms, and the stroke pass alone is 0.4 ms at p50 and 0.6 to 0.7 ms at p95 on that part. Rom accepted the determination to split the populations and budget steady frames at 1.5 ms (`release/v1-freeze.json`, `rasterProvenance.renderBudget`; derived from the Pentium Gold 8505 row, the M5 Chromium and WebKit rows, and the 0.5 to 0.6 ms raster increment measured there). WebKit's timer is clamped to 1 ms, so its budget reads the mean. Amendment, 2026-10-31, a change from the determination approved by Rom the same day ("Proceed with recommendations"): the determination bounded the p95 of upload frames by the steady figure plus 2 ms plus the `texImage2D` p95. The M5 in Chromium cannot meet that: once roughly 12 MiB are in flight the driver blocks a single 1 MiB tile for about 10 ms, in bursts, and the upload budget always lets one tile through. Those frames stay well under 16.7 ms, so the rule that pacing has to guarantee is "no upload frame longer than one 60 fps frame", asserted on every hardware row.
- 2026-10-31, ADR 0018 open question 5 (the texture constant, the per-plan cap and the Tier 0 cap): measured in #108 on three real renderers, with software GL kept apart as relative costs. The constant is `RASTER_DEFAULTS` in `src/config/defaults.ts`, frozen beside it in `release/v1-freeze.json`; the reasoning and the renderers it came from are in `docs/raster-render.md` and `docs/benchmark-report.md`. The pointer into the pvec ADR itself is edited in `libviprs/pvec` by its own task.
