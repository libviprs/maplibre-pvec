# Range and cache model

Decision: [ADR 0003](adr/0003-range-model.md).

## Reading

Only HTTP `Range` requests are used. The order is: header and manifest in one range, then the spatial directory, then the Tier 0 blocks that intersect the viewport, with adjacent blocks coalesced into one range. The directory is read whole while it is at most 64 KiB (provisional) and walked progressively above that. A whole-directory bootstrap took 3 serialised round trips on the provisional synthetic container, so the request count is `2 + R` for `R` non-adjacent Tier 0 ranges.

Requests carry static `headers` and an optional `auth` hook for tokens or signatures. A change of the artifact's ETag or version mid-session is a `PVecVersionError`.

## Scheduling

The scheduler has priority classes, cancels work that leaves the viewport, coalesces ranges and applies back-pressure (`PVecBackpressureError`). Cancellation is a normal outcome (`PVecAbortError`) and is never shown to the host.

## Cache tiers

Three tiers, each with a byte ceiling (`CacheBudget`): compressed bytes, decoded bytes and GPU bytes. Eviction ranks by value, with on-screen entries first and refined generations above previews. The refinement cache has its own ceiling (`CACHE_DEFAULTS`, 48 MiB, 4096 entries, quarter-zoom buckets).

The frozen defaults are in `release/v1-freeze.json`. They were tuned on software GL against a provisional container, so a retune on hardware and on the frozen layout is listed in [deferred work](deferred.md), issues 2 and 34.

## A raster tile through the three tiers

A tile of a PVec raster passes through all three tiers, and the bytes in each are different bytes, so the tiers add up without counting anything twice.

1. **Encoded, in the `compressed` tier.** The provider's `tile()` hands the layer the tile's encoded bytes as a `Uint8Array` that the layer owns; the pvec-wasm handle behind it is released as soon as the bytes are copied (`libviprs/pvec` `docs/WASM_ABI.md`, section "Rasters (version 2...)", paragraph "Cache policy": `release(handle)` also drops the tile's range from the module, so the module holds no tile after that and the host's cache answers a second ask). The layer keeps the copy in the `compressed` tier under its own ceiling, keyed `rID/level/col/row`. That copy is what makes a context loss free: a restore decodes it again and issues no request. A tile whose bytes the tier evicted is asked for again, which is the same path as a first load.
2. **Decoded, in the `decoded` tier.** The worker decodes a copy of the encoded bytes (the retained ones are never transferred away) and posts an `ImageBitmap`. From the moment it lands the bitmap is an entry of `edge * edge * 4` bytes, until `texImage2D` returns. Then it is closed and leaves the tier. `ResourceLimits.maxDecodedBytes` (and the tier's own ceiling, whichever is lower) bounds the bitmaps held plus the ones in flight, and the decode queue stops asking for tiles when the next one would cross it. This mirrors LIMIT-16 on the host side, because the browser's decoder is outside pvec's accountant.
3. **Texture, in the `gpu` tier.** An entry of `edge * edge * 4` bytes (the RGBA8 upload size, whatever the codec), released with `deleteTexture`. Its bitmap has already left the `decoded` tier, so a tile is never a bitmap and a texture at once.

Eviction of tiles ranks, in this order: in the current plan, then the distance of the tile's level from the level the plan wants (a coarser level kept under the wanted one outranks a finer level that is no longer wanted), then recency, then the key, so a run is reproducible. A decode whose tile left the plan while it was in flight is refused on arrival by the generation check `src/refine/generation.ts` does for curves, and its bitmap is closed instead of uploaded. The coarser level kept under a wanted level is dropped once the finer tiles that replace it are resident.

Stroke buffers are not entries of the `gpu` tier today (the buffer pool does its own accounting), so a texture can only evict textures. If the pool ever moves into the tier, the ranking above has to put strokes first.
