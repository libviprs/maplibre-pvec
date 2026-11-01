# Buffer model

The Tier 0 line pipeline draws one instance per segment. A segment is one 40-byte record in a GPU arena page.

| bytes | type | field |
|---|---|---|
| 0..15 | 4 x f32 | endpoint 0 as `x_hi, y_hi, x_lo, y_lo` |
| 16..31 | 4 x f32 | endpoint 1 as `x_hi, y_hi, x_lo, y_lo` |
| 32..35 | f32 | cumulative arc length at endpoint 0, for dash phase |
| 36..39 | u32 | `widthIndex` (12 bits) , `dashIndex` (12 bits), `flags` (8 bits) |

`hi = fround(v)` and `lo = fround(v - hi)`, so no world coordinate reaches the GPU as a single `f32`. The shader subtracts the camera centre (also split hi/lo) word by word before scaling, which keeps deep-zoom precision.

Flags: bit 0 has a previous segment, bit 1 has a next segment (set by `packPolyline`, cleared across a non-finite break), bits 2-3 cap (butt, square, round), bits 4-5 join (miter, bevel, round).

Joins read the neighbour through two extra instance attributes bound on the same buffer, one record before (`a_prev`) and one after (`a_next`). The pool therefore keeps a 40-byte guard on each side of every range (`guardBytes`).

1e6 segments are 40 MB, and the 4 MiB pages hold 104 857 records each. The pool sub-allocates from a free list, defers frees until the frame that could reference them completes, compacts a page above 35 percent fragmentation, and keeps the source bytes so a lost context can be rebuilt without decoding again.

A pure pan changes only the camera uniforms. It performs no buffer writes.

## Raster textures

A raster tile is an RGBA8 texture of `edge * edge * 4` bytes held as an entry of the source's `gpu` tier, uploaded under the same 4 MiB and 2 ms a frame budget as the stroke buffers. The encoded bytes and the decoded bitmap of the same tile live in the other two tiers; see [range and cache model](range-cache-model.md#a-raster-tile-through-the-three-tiers). A context loss drops the textures from the tier with their GL objects and rebuilds them from the retained encoded bytes.
