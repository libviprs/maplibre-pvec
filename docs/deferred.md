# Deferred work

Things that cannot be done for real in this repository today, each with the reason and what unblocks it.
Append a section per issue.

## #50 Tier 0 rendering and interaction

What is done and tested: the 40-byte segment layout with hi/lo coordinates and degenerate rejection, the stroke shaders and a CPU reference mesh (joins, caps, miter limit, dash), real WebGL2 pixel tests through SwiftShader (width at bearings 0, 22.5 and 45 and dpr 1 and 2, antialias symmetry, dash continuity, miter against bevel), the buffer pool (free list, compaction, deferred free, upload budget, forced-race commit, context-loss rebuild, accounting), `GlStateGuard` with the debug diff, the context-loss and repaint helpers, picking over the analytic evaluator, the Tier 0 decoder (sliced, id-set coverage, fetch gate) and the conic and trim preview tessellation with measured declared error.

What I could not do here, and what unblocks it:

- The decoder reads a `BlockCursor` interface. The real cursor is the shared PVec WASM decoder, which has no released artifact yet. The request-log assertion on the known-truth fixtures and the "no single slice above 8 ms on the medium fixture" measurement need that artifact and the M2.1 fixtures.
- `Tier0Decoder` slices are tested with an injected clock. The browser timing of a slice waits for the same WASM artifact.
- The preview tessellation takes a `ScreenPipeline` interface. Wiring it to the full source, georeference, projection and camera evaluator waits for the GIS transform work (#42). The 1e4 sample check runs against an affine pipeline, not the WASM evaluator.
- Pick distances come from an `AnalyticEvaluator` interface that the WASM evaluator will implement. The tests use analytic circles. The 5 ms p95 on 1e6 entities is measured with a grid index in Node, not the PVec spatial index.
- The MapLibre custom layer that wires decoder, pool, renderer and guard together is not written. The snapshot comparison against MapLibre's own layers (0.1 percent), the symbol-layer stencil check, the forced `WEBGL_lose_context` snapshot with zero new range requests, the 60 second frame-time runs, the draw-call and CPU-time budgets on the reference machine and the 1e6-segment draw all need that layer and a reference machine, not a software rasteriser.
- Round join and cap shading and the bevel and miter wedge edges are not antialiased along their outer edge (the wedge is drawn solid). The CPU mesh is exact for them.
- The first-useful-drawing SLO harness (`bench/slo`, `docs/slo.md`, the pinned fixture and the network emulation) needs the remote source (#18), the gold fixture digest and a stable machine. Not started.
- A scan of the built bundle for `gl.lineWidth` waits for a bundle build. Today the test scans `src/`.
