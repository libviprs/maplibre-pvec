# maplibre-pvec

A MapLibre GL JS add-on that streams [`.pvec`](https://github.com/libviprs/pvec) directly and
renders the PVec ISO-aligned 2D geometry profile as a progressively refined GIS overlay, preserving
canonical vector precision instead of making fixed-resolution MVT the primary blueprint path.

```text
remote .pvec -> Rust/WASM decoder -> Tier 0 GPU buffers + worker-decoded curves
             -> WebGL2 custom layer -> MapLibre camera
```

## Status

**Specification stage. There is no implementation in this repository yet.**

Eight phases and 64 issues under [#1](https://github.com/libviprs/maplibre-pvec/issues/1).

## The rules that decide the design

- Browser geometry semantics come from PVec's own Rust evaluator compiled to WASM. ISO curve
  mathematics is not reimplemented in TypeScript.
- **WebGL2 is the v1 rendering baseline**, because MapLibre's current custom-layer interface hands
  out a `WebGL2RenderingContext`. WebGPU stays experimental until a stable integration surface
  exists.
- PVec spatial chunks are **not** display zoom tiles.
- Canonical curves stay analytic; only GPU display buffers are tessellated, and adaptive
  tessellation evaluates error after the complete source → GIS → MapLibre → screen transform.
- Preview and refined generations replace the **same stable entity**, and a superseded generation
  cannot reach the screen.
- `SharedArrayBuffer` is never required; transferable buffers are the default.
- Mercator is the v1 projection conformance baseline. Other projections are capability-gated until
  they prove equivalent transform and error behaviour.
- Picking and query APIs are part of v1, because a plan viewer needs stable entity interaction.

## Related repositories

| Repository | Role |
|---|---|
| [`libviprs/pvec`](https://github.com/libviprs/pvec) | the `.pvec` semantic profile, container and shared geometry evaluator |
| [`libviprs/pvec-gold-fixtures`](https://github.com/libviprs/pvec-gold-fixtures) | the fixture corpus the browser conformance suite reads |
| [`libviprs/libviprs`](https://github.com/libviprs/libviprs) | produces `.pvec` from DWG and vector PDF |

Documentation starts at [docs/README.md](docs/README.md). The v1 freeze and what is still open are in [docs/v1-readiness.md](docs/v1-readiness.md).
