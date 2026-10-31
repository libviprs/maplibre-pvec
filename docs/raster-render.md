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
