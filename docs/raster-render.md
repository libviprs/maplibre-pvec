# Rasters in the custom layer: texture constant and measured costs

ADR 0009 records the decisions, this page records the numbers. Every number here came from `tests/e2e/102-raster.spec.ts` (through `tools/evidence-102.mjs`, file `release/evidence/102-raster.json`) on:

Chromium 130 from mcr.microsoft.com/playwright:v1.48.2-jammy, software GL (ANGLE on SwiftShader, no GPU), linux/amd64 container on MARS (devshell@192.168.0.100, native x86_64, 24 cores)

It is software GL, so nothing below says anything about a GPU's upload time. The fixture is a synthetic picture cut into 256 px tiles by `tests/unit/helpers/raster_fixture.ts`, served by a fixture provider in place of the pvec-wasm exports (`libviprs/pvec#221` does not exist yet), so the tile bytes are small and the decode times are a floor, not what a real scan costs.

## Texture constant

A tile is uploaded as RGBA8 with no mipmaps, so it costs `tile_edge * tile_edge * 4` bytes in the `gpu` tier: 262,144 bytes for the 256 px tiles measured (the evidence value), 1 MiB at 512 px and 4 MiB at 1024 px, by arithmetic. The bound is tiles in view per raster per level, at most `(ceil(W/edge)+1) * (ceil(H/edge)+1)` (20 at 1080p and 54 at 4K with 512 px tiles), times two for the retained coarser level, times the rasters drawn, times that constant. The default 128 MiB `gpu` tier holds 128 tiles of 512 px, so one raster at 4K (108 MiB) fits and two do not; the second steps down a level (unit test `raster_102`, and the Playwright spec with a 3-tile tier). In the run, the layer's `gpuTier` diagnostic equalled the textures held times the constant exactly.

## Decode per tile, per codec (worker, `createImageBitmap`)

| Codec | Cold worker (first tiles) | Warm worker |
|---|---|---|
| PNG, 8-bit RGBA | about 45 ms | 0.9 to 1.3 ms |
| PNG, 1-bit gray | about 1 ms | 0.7 to 1.1 ms |
| JPEG, gray | about 44 ms | 0.6 to 0.9 ms |

The cold figure is the first decode in each of the two workers and includes starting the worker; the 1-bit run happened after the workers were warm. These are the times the worker measures around `createImageBitmap`, so none of it is on the main thread: the spec counts main-thread `createImageBitmap` and `Image.decode` calls and finds 0.

## Uploads per frame and frame cost

Tiles uploaded per frame while the three-raster scene loaded: 6, 6, 3, 3 (18 tiles, 4.5 MiB), against the budget of 4 MiB and 2 ms a frame: the byte budget lets 16 tiles of 256 px through a frame, so these frames were stopped by the tiles being ready, not by the budget. The unit test checks the budget itself (ten 1 MiB tiles take frames of 4, 4 and 2). A steady frame (same camera, nothing in flight) cost 0.2 ms at the 95th percentile on the main thread, under ADR 0005's 1 ms, measured with `performance.now` around `layer.render` (0.1 ms resolution).

## What is not measured

Hardware GPU upload time, Firefox and WebKit, tiles of 512 px and 1024 px from a real encoder, and anything from a real `.pvec` raster stream. See `docs/deferred.md`, section for issue 102.

## Comparison method

The Playwright spec compares the real frame with a CPU reference that shares no code with the renderer (it inverts the placement and samples bilinearly per tile with `CLAMP_TO_EDGE`). A pixel counts as different when a channel lies more than 2 outside the range the reference takes over positions shifted by up to 0.06 px, because SwiftShader snaps vertices to a coarse subpixel grid. The ratio against the 0.1 percent threshold was 0 for the rotated, sheared vector under a stroke. A GPU run should use a much smaller shift.

## Decode in the engines, and hostile tiles (#107)

The browser decodes, so what it does with each tile variant ADR 0018 allows is part of the contract. `tests/e2e/grid/107-raster-grid.spec.ts` runs in every grid project (Chromium 111 and 130, Firefox 131, WebKit 18.0, native x86_64 on MARS, software GL). A module worker calls `createImageBitmap` with `colorSpaceConversion: "none"`, `imageOrientation: "none"` and `premultiplyAlpha: "premultiply"`, transfers the bitmap, the page uploads it with `texImage2D` and reads known pixels back. Sixteen fixtures from `tools/raster-fixtures.sh` (Pillow 11.0.0 in a container, reproducible, `--check` rebuilds and compares) cover PNG gray at 1 and 8 bits, gray with alpha, RGB and RGBA, JPEG gray and RGB, baseline and progressive, and WebP `VP8L`, `VP8` and `VP8X` with and without alpha. Each decodes to its size and to the expected pixels (premultiplied where it has alpha) in every engine. A PNG carrying `sRGB` and `gAMA` chunks, and one carrying an `iCCP` chunk, are not recoloured under `none`; the grid annotation records it per engine (in the run behind this page none of Chromium 111, Chromium 130, Firefox 131 or WebKit 18.0 recoloured either file), and where an engine applies them anyway the producer rule (libviprs strips colour chunks, libviprs/libviprs#1330) is the cover.

`tests/e2e/range/107-raster-hostile.spec.ts` (Chromium) checks the host side of the hostile cases:

- A raster the module refuses by a rule is one `rasterskipped` with that rule, no `error`, no exception, and the strokes and the other raster draw: the thirteen rule assignments of pvec's corpus (`crates/pvec-testkit/src/raster_hostile.rs`) are run through the fixture provider, and the frame equals its raster-free twin (0 differing pixels). The refusals are thrown by the fixture provider, as the pvec-wasm adapter will when the module refuses a tile. Whether pvec's sniffers refuse the real bytes is `libviprs/pvec`'s own test (`issue_219_hostile_tiles.rs`); running them from here needs the adapter, see [deferred work](deferred.md).
- A valid header over a corrupt body is a missing tile. It is attempted three times in all (waits of 30 and 60 frames), counted in `RasterFrameStats.failedTiles` and `decodeFailures`, never in a loop, and the retained encoded bytes are decoded again without a request: 3 tiles, 9 attempts, no exception.
- A 1024 px progressive JPEG (the largest tile, 378 KB) decodes in a worker, never on the main thread, in 1.3 s in the container's Chromium (a relative cost of that machine, not a budget), while the layer's own time per frame stays at 0.4 ms at the 95th percentile.
- `limits.maxDecodedBytes` bounds the plan as well as the queue: a 1024 px raster whose 16 full-resolution tiles would not fit a 4 tile cap is drawn from the 4 tile level.
- An attribution containing markup reaches a real MapLibre attribution control as text: the `<img>` and `<script>` come out as characters and no element is made.
