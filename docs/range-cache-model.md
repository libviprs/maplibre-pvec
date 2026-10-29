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
