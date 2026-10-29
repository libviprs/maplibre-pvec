# ADR 0003: Range model

- Status: Accepted
- Date: 2026-10-29
- Evidence: `docs/spikes/02-range-bootstrap.md`

## Context

Remote `.pvec` is read with HTTP `Range` requests only. The physical layout is not frozen until `P1.8`, so the evidence is from a provisional synthetic container on a hermetic origin and describes request patterns, not final bytes.

## Decision

1. Bootstrap order: header and manifest in one range, then the spatial directory, then the Tier 0 blocks intersecting the viewport, with adjacent blocks coalesced into one range.
2. Read the spatial directory **whole** while it is at most 64 KiB (measured 4.3 to 42.7 KB across the fixtures (10k to 200k entities)); walk it progressively above that. The 64 KiB switch is **provisional** and is a phase 8 tuning value (`M8.6`).
3. Whole-directory bootstrap costs 3 serialised round trips for every preset and fixture. Requests are `2 + R`, with `R` the number of non-adjacent Tier 0 ranges (3 for full extent, 21 for dense detail and 6 for sparse edge on 200,000 entities in 200 per block).
4. Injected 200 ms RTT (200k entities, dense detail): whole directory 615 ms to first useful drawing, progressive 1,032 ms.

## Consequences

- The file layout must keep the root directory node first and the nodes contiguous so a whole read is one range.
- Progressive reads saved 23 KB of directory bytes and cost two extra round trips, so they are a fallback for oversize directories, not the default.
- Coarser blocks cut requests (21 to 14 in dense detail) but read 41% more Tier 0 bytes. The block granularity is a layout and tuning matter for `P1.8` and `M8.6`.
- Speculatively merging the first two reads into one is unmeasured and left open.
