# Architecture

The add-on streams a `.pvec` artifact into a MapLibre GL JS map as one custom layer. It reads with HTTP `Range` requests only, gets a first drawing from the Tier 0 blocks, and then refines curves in workers while the camera is still.

```text
  .pvec on an origin (Range only)
        |
  PVecSource  --  scheduler, coalescer, tiered cache   (range-cache-model.md)
        |
  Tier0Decoder (time-sliced) --> packed segments       (buffer-model.md)
        |                                   |
  PVecLayer (custom layer)            Refiner + worker pool  (tier0-refinement-lifecycle.md)
        |                                   |
  stroke renderer (WebGL2)  <--  refined buffers, newer generation wins
```

## Pieces

- `src/source`: range scheduling, coalescing, cancellation, artifact identity (an ETag or version change is an error, never a silent mix) and the three cache tiers.
- `src/decode`, `src/render`: the Tier 0 decoder and the packed 40-byte segment records, the buffer pool and the stroke pipeline.
- `src/transform`: georeferencing, the Mercator adapter, the inverse viewport transform, the screen-space error evaluator and the local-origin precision scheme.
- `src/refine`, `src/workers`: the policy, the cost-aware queue, generation replacement, the refinement cache and the worker pool.
- `src/layer`: `PVecLayer`, the only object MapLibre sees. Importing the package does no work.
- `src/style`, `src/text`, `src/hatch`: optional entries, not reachable from the main entry.

## What this package does not define

Curve mathematics, the numeric policy and the container layout come from `libviprs/pvec` ([PVec semantic reuse](pvec-semantic-reuse.md)). Here the evaluator is a WASM module behind a packed interface, and display fidelity is the only tolerance this package owns.

## Decisions behind it

The [ADR index](adr/README.md) holds the eight browser decisions and the WebGPU record. What is not built or not measured yet is in [deferred work](deferred.md), and [v1 readiness](v1-readiness.md) says which acceptance items that leaves open.
