# Spike 02: HTTP range bootstrap to first useful drawing

Spike for M1.2. Harness: `spikes/range-bootstrap/` (`tools/spike-node.sh range-bootstrap`). Raw numbers: `spikes/range-bootstrap/results.json`.

## What I measured, and what I could not

The PVec physical layout is not frozen until `P1.8` and the container reader (`P4.1`, `P4.5`, `P5.1`, `P5.4`) does not exist yet, so I measured against a **provisional synthetic container**. It has a 64 byte header, a 4 KiB manifest, a spatial directory (40 bytes per entry, a tree with the stated fanout, root node first) and Tier 0 blocks of 48 bytes per entity in Morton order. Entities are 60% in a dense corner square, the rest uniform. So the numbers below describe the request pattern as a function of fanout and block granularity, exactly as the issue asks, and they are not statements about the final PVec file. The real fixtures (`libviprs/pvec-gold-fixtures#1`) and the real reader are listed as deferred in `docs/deferred.md`.

- **Origin:** a Node `http` server started and torn down inside the run, serving `206` ranges with `Access-Control-Allow-Origin`, `Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length` and `Accept-Ranges: bytes`. No third-party endpoint.
- **Network:** the container runs with `--network none`, so the harness passes with outbound network denied and only loopback available.
- **Client:** Node 22 `fetch` with `Range` only. Adjacent Tier 0 blocks are coalesced into one range.
- **Platform:** x64 Linux container on the docker host `mars` (NAS-native x64, not arm64), Node v22.23.4.
- **Viewport presets:** full extent, dense detail (0.05 x 0.05 inside the dense corner), sparse edge (0.15 x 0.15 at the far corner).
- **Fixtures:** 10,000 and 200,000 entities, with block granularity 100/200/1000 entities and directory fanout 16/64.
- "Serialised round trips" counts dependent request levels (requests issued in parallel count once). "First useful drawing" is the time until every Tier 0 byte for the viewport has arrived (no decode or draw, since the production source does not exist).

## Results

Bytes are split by category: header+manifest, directory, Tier 0 payload. RTT is the injected origin latency.

| entities | per block | fanout | blocks | preset | directory read | RTT ms | requests | round trips | header+manifest B | directory B | Tier 0 B | ms to first useful drawing |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10,000 | 100 | 16 | 100 | fullExtent | whole | 0 | 3 | 3 | 4,160 | 4,280 | 480,000 | 16.1 |
| 10,000 | 100 | 16 | 100 | fullExtent | progressive | 0 | 10 | 4 | 4,160 | 4,280 | 480,000 | 14.1 |
| 10,000 | 100 | 16 | 100 | denseDetail | whole | 0 | 15 | 3 | 4,160 | 4,280 | 148,800 | 8.6 |
| 10,000 | 100 | 16 | 100 | denseDetail | progressive | 0 | 20 | 4 | 4,160 | 3,480 | 148,800 | 10.9 |
| 10,000 | 100 | 16 | 100 | sparseEdge | whole | 0 | 4 | 3 | 4,160 | 4,280 | 19,200 | 5.5 |
| 10,000 | 100 | 16 | 100 | sparseEdge | progressive | 0 | 6 | 4 | 4,160 | 1,080 | 19,200 | 6.9 |
| 200,000 | 200 | 16 | 1000 | fullExtent | whole | 0 | 3 | 3 | 4,160 | 42,680 | 9,600,000 | 17.6 |
| 200,000 | 200 | 16 | 1000 | fullExtent | progressive | 0 | 70 | 5 | 4,160 | 42,680 | 9,600,000 | 98.7 |
| 200,000 | 200 | 16 | 1000 | denseDetail | whole | 0 | 21 | 3 | 4,160 | 42,680 | 1,776,000 | 11.5 |
| 200,000 | 200 | 16 | 1000 | denseDetail | progressive | 0 | 51 | 5 | 4,160 | 19,360 | 1,776,000 | 17.7 |
| 200,000 | 200 | 16 | 1000 | sparseEdge | whole | 0 | 6 | 3 | 4,160 | 42,680 | 144,000 | 5 |
| 200,000 | 200 | 16 | 1000 | sparseEdge | progressive | 0 | 10 | 5 | 4,160 | 2,360 | 144,000 | 9.5 |
| 200,000 | 200 | 64 | 1000 | fullExtent | whole | 0 | 3 | 3 | 4,160 | 40,640 | 9,600,000 | 14.4 |
| 200,000 | 200 | 64 | 1000 | fullExtent | progressive | 0 | 19 | 4 | 4,160 | 40,640 | 9,600,000 | 18.5 |
| 200,000 | 200 | 64 | 1000 | denseDetail | whole | 0 | 21 | 3 | 4,160 | 40,640 | 1,776,000 | 10.2 |
| 200,000 | 200 | 64 | 1000 | denseDetail | progressive | 0 | 32 | 4 | 4,160 | 28,800 | 1,776,000 | 13.4 |
| 200,000 | 200 | 64 | 1000 | sparseEdge | whole | 0 | 6 | 3 | 4,160 | 40,640 | 144,000 | 6.1 |
| 200,000 | 200 | 64 | 1000 | sparseEdge | progressive | 0 | 8 | 4 | 4,160 | 4,800 | 144,000 | 9.7 |
| 200,000 | 1000 | 16 | 200 | fullExtent | whole | 0 | 3 | 3 | 4,160 | 8,520 | 9,600,000 | 17.7 |
| 200,000 | 1000 | 16 | 200 | fullExtent | progressive | 0 | 16 | 4 | 4,160 | 8,520 | 9,600,000 | 20.6 |
| 200,000 | 1000 | 16 | 200 | denseDetail | whole | 0 | 14 | 3 | 4,160 | 8,520 | 2,496,000 | 10.5 |
| 200,000 | 1000 | 16 | 200 | denseDetail | progressive | 0 | 23 | 4 | 4,160 | 6,280 | 2,496,000 | 11.6 |
| 200,000 | 1000 | 16 | 200 | sparseEdge | whole | 0 | 4 | 3 | 4,160 | 8,520 | 288,000 | 6 |
| 200,000 | 1000 | 16 | 200 | sparseEdge | progressive | 0 | 7 | 4 | 4,160 | 2,120 | 288,000 | 6.4 |
| 200,000 | 200 | 16 | 1000 | denseDetail | whole | 200 | 21 | 3 | 4,160 | 42,680 | 1,776,000 | 615 |
| 200,000 | 200 | 16 | 1000 | denseDetail | progressive | 200 | 51 | 5 | 4,160 | 19,360 | 1,776,000 | 1032.4 |

## Reading the table

- **Whole directory** costs a fixed 3 round trips (header+manifest, directory, Tier 0) whatever the fixture or preset. Requests are `2 + R` where `R` is the number of non-adjacent Tier 0 ranges: 3 for full extent (the whole file is one coalesced range), 21 for dense detail on 200k/200, 6 for sparse edge.
- **Progressive directory** (walk the tree, one level per round trip) reads fewer directory bytes when the viewport is small (200k/200/16 sparse edge: 2,360 B instead of 42,680 B; dense detail 19,360 B instead of 42,680 B) but it costs 4 to 5 round trips and up to 70 requests (full extent, fanout 16) because every touched node is its own range.
- **Latency dominates.** With 200 ms injected RTT (200k/200/16, dense detail) the whole-directory read finished in 615 ms and the progressive read in 1,032 ms. The progressive saving was 23 KB of directory bytes, which is under 1 ms of transfer on any realistic link, so it never pays for the two extra round trips.
- **Block granularity trades requests for bytes.** 1000 entities per block cut dense-detail requests from 21 to 14 but read 2,496,000 Tier 0 bytes instead of 1,776,000 (+41%).
- **Fanout 16 vs 64** changed the directory size by under 5% (42,680 B vs 40,640 B) and the progressive request count more than the byte count.

## Decision

1. Bootstrap order: one range for header+manifest, then the spatial directory, then the Tier 0 blocks that intersect the viewport, coalescing adjacent block ranges.
2. **Read the spatial directory whole** when its size is at or below 64 KiB (measured 4.3 to 42.7 KB across the fixtures, 10k to 200k entities). Above that size, fall back to the progressive walk, because a directory beyond that is where the byte saving could start to matter. The 64 KiB switch is **provisional** and is a phase 8 tuning value (`M8.6`).
3. The bootstrap may not exceed **3 serialised round trips** in the whole-directory case. Its request count is `2 + R`; `R` is bounded by the coalescer and must be reported per preset in the phase 3 benchmark.
4. Directory layout must keep the root node first and nodes contiguous, so that the whole-directory read is a single range.

Not measured here, and so not decided: merging the first two reads by speculatively fetching header+manifest+directory in one range (it would save one more round trip), CDN behaviour (`M3.8`), and any decode or draw cost.
