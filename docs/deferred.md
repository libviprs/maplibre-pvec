# Deferred work

Things that cannot be done for real in this repository today, each with the reason and what unblocks it.
Append a section per issue.

## Issue #2: phase 1 spikes and browser ADRs

| Item | Why it cannot be done here | What unblocks it |
|---|---|---|
| M1.3 evaluator cost on the real `pvec` WASM (single-evaluation ns, amortised ns per point at 1e2 to 1e5 on the named fixtures, repeated-knot NURBS, packed output) | `libviprs/pvec` has no WASM build of the evaluator and no packed interface yet (`P7.2`, `P7.3`). Only the call boundary was measured (`docs/spikes/03-wasm-evaluator.md`). | A `pvec` WASM artifact exposing the packed API, plus the `O1.5` pathological probes. Re-run `spikes/wasm-evaluator` against it. |
| M1.5 Tier 0 coverage audit and preview error accounting (`docs/spikes/05-tier0-coverage.md`) | Needs the Tier 0 complete-coverage stream with declared preview errors (`P1.7`, `P5.4`), the spatial directory (`P5.1`), the evaluator for reference curves and a spline-heavy fixture (`O2.9`). None exists. | The `pvec` Tier 0 stream and the `pvec-gold-fixtures` corpus with named spline-heavy members. |
| M1.2 on the real container and fixtures | Measured on a provisional synthetic container because the layout is not frozen until `P1.8`. Numbers are about request pattern and fanout, not final bytes. Platform is x64 (the docker host), not arm64. | The frozen layout and reader (`P4.1`, `P4.5`, `P5.1`, `P5.4`), then re-run `spikes/range-bootstrap` on an arm64 container as the default platform. |
| Hardware GPU numbers | Every browser run used software GL (SwiftShader in Chromium, the container's WebKit software path). Stroke frame times and upload times are relative costs only. | A runner with a real GPU for the Chromium and WebKit runs (and `M8.4` benchmarks). |
| Second and third engine for the custom-layer surface, precision and WASM boundary | The container's Firefox has no WebGL2 (`getContext("webgl2")` returned null), and the custom-layer, precision and WASM spikes ran in Chromium only. | A Firefox build with a working software or hardware WebGL2 in the container, and a CI browser pin (`M2.8`). |
| WebGPU compute probe numbers | The container's Chromium has no usable WebGPU adapter without a GPU; availability is recorded, tessellation time cannot be (`docs/spikes/07-workers-webgpu.md`). | A GPU-backed runner. v1 does not depend on it (ADR 0008). |

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

## #42 GIS transform and precision

The pure TypeScript math is done and unit-tested in node. These parts need something I do not have here:

- **MapLibre agreement for the jacobian (M4.2).** The 1e-6 relative check against MapLibre's own projection needs the custom-layer matrices from a live map. Today `jacobianAt` is checked against a finite difference of this repository's own mercator camera. Needs the Playwright harness from #10.
- **GPU measurement of vertex error (M4.5, M4.8).** `docs/precision.md` is measured by emulating the shader with `Math.fround`. The browser matrix (`tests/browser/stress/precision.spec.ts`) and the rendered-snapshot diffs need real WebGL2 contexts, which needs the Tier 0 pipeline from #50 and the Playwright CI from #10. `position.glsl` has not been compiled against a GL context yet.
- **WASM curve evaluation (M4.4, M4.7).** `chordErrorPx`, `subdivide` and `conservativeScreenBounds` take curves through a `CurveRef` / `CullableEntity` interface. The known-truth families in the tests are small stand-ins, because the shared PVec evaluator WASM artifact and the M2.1 fixtures are not available yet. Wiring the real evaluator is a swap behind that interface.
- **Pixel-identical culling (M4.7).** The zero-false-cull check uses dense curve samples against the viewport as the pixel-set proxy. The reference render with culling disabled needs the renderer from #50.
- **`setGeoReference` on the layer and the per-frame upload budget (M4.6).** `GeoReferenceState`, `PositionRebuild` (position buffers only, time-sliced) and `tessellationStillValid` are in. The layer method, the `georeferencechange` event and the budget scheduler belong to #50 and the public API issue.
- **Stress run outputs.** `bench/out/precision-stress.json` is written when `PRECISION_STRESS_OUT` is set, but there is no bench job to consume it yet.


## #18 PVec remote source

What I could not do for real here, and what unblocks each part:

- **S3-compatible object storage and a real CDN in a compose stack.** The transport tests run against a hermetic Node range origin and a small caching reverse proxy that bind 127.0.0.1 inside the throw-away test container, so nothing touches a bucket, a CDN or any third-party endpoint and no credential exists. They cover 206, 200-to-range, 416, multipart, 500/503 retry, truncated body, connection reset, strong versus weak ETag and immutable cache hits. What they cannot show is how a particular vendor's gateway behaves (MinIO, S3, CloudFront). That needs the compose stack with pinned image digests, an explicit `--platform`, and the per-result platform and digest summary the issue asks for. It waits for the CI harness in #10 (M2.8) to define the compose runner.
- **Browser CORS enforcement.** `Access-Control-Expose-Headers` is emulated by a fetch wrapper that hides every header a browser would hide. A real browser run (Playwright through the lock, against the origin) is needed to prove the same names are hidden in Chromium, Firefox and WebKit. It waits for the Playwright CI in #10.
- **Ten-minute pan and zoom soak with a rendered Tier 0 viewport.** The cache soak is a seeded 200,000 operation simulation with a pinned viewport, asserting per-tier peaks, accounting against an independent total, and that the viewport stays resident. The ten-minute wall-clock run, and the "complete Tier 0 viewport renders" half, need the Tier 0 renderer (#50).
- **GPU buffer deletion against a real GL context.** The cache releases GPU entries through a `release` hook and the tests count buffers on a fake GL object. Proving `deleteBuffer` on a `WebGL2RenderingContext` and the context-loss path belongs to the layer's teardown work in #50.
- **ADR 0003 numbers.** The request ceiling (3 requests, 4 KiB prefix plus the directory) and every coalescing, scheduler and cache threshold are marked PROVISIONAL in code. ADR 0003 and the measured bootstrap sequence are produced by the phase 1 spikes (#2); the benchmarks that tune them are M8.2 and M8.6. Nothing here is frozen before those.
- **WASM container reader.** `bootstrap.ts` parses the container prefix (header, manifest, block directory) in TypeScript. That is layout parsing, not geometry semantics, but the shared reader in `libviprs/pvec` should replace it once its WASM artifact is released. The spatial directory (kind 3) is only located, not decoded, for the same reason; `queryBounds` uses the block directory's per-block bounds meanwhile.
- **Block checksums and decompression.** Verifying the XXH3 block sums and the codecs is part of the decode path (#50), not the source.

## #10 browser conformance suite

What landed: the pinned corpus registry and fail-closed loader (shared by Vitest and the in-page Playwright
suites), the evidence-class gating and claim table, the run summary, the guards (no converter image, no STEP
parsing, no tolerance literal, no external host), the hermetic range origin and the four-job runner with
declared-pending gates. What follows could not be done for real yet.

| Item | Why it waits | Unblocked by |
|---|---|---|
| Canonical `.pvec` path per fixture (`M2.1`) | pvec has not generated canonical containers from the fixture geometry. The registry records `canonicalPvec: PENDING` for all 30 fixtures instead of inventing a path. | `libviprs/pvec#1` P2.4 |
| Headless evaluator tests and the five-mutation table (`M2.3`) | They run the real WASM build of the shared evaluator, which does not exist as an artifact yet. | #2 (M1.3) and `libviprs/pvec#1` P7.2, P7.3 |
| Equivalence layer and its tolerance access point (`M2.4`) | The tolerances come from the PVec build's policy surface (P1.2). The guard already forbids local ones and exempts `tests/policy/access.ts` for when it lands. | `libviprs/pvec#1` P1.2, P2.6 |
| Transform and display pipeline suite (`M2.5`) | #42 landed the transform stack and error evaluator, but over stand-in curves, so the end-to-end suite needs real fixture curves from the WASM evaluator. Registered as pending gate `pipeline`. | #2 (M1.3), `libviprs/pvec#1` P2.4 |
| Tier 0 preview and refinement suite (`M2.6`) | There is no Tier 0 decoder or refinement scheduler to drive. Registered as pending gate `tier0`. | #50 (M5.1) and the refinement issues |
| Parser and range security suite (`M2.7`) | It needs the browser reader and the limits from `M3.1`/`M3.6`. Registered as pending gate `hostile-input`. | #18, `libviprs/pvec#1` P4.7, P4.8 |
| Real-world dual-oracle fixtures (`M2.2`) | The corpus has no `DUAL_ORACLE_EQUIVALENT` or `REAL_WORLD_DIFFERENTIAL` fixture yet (a second converter has not run). The registry, gating rule and claim table already handle both classes and are tested with reclassified fixtures. | `libviprs/pvec-gold-fixtures` second-oracle route |
| Snapshot baselines keyed by renderer string (`M2.8`) | There is nothing rendered to snapshot. The job exists and reports pending. | #50 |
| Origin as a separate container, x64 labelling on arm64 default | The origin is a loopback Node process started and stopped by Playwright inside the same throw-away container as the run, which is hermetic but not a second container. The gate ran on the x64 docker host only, so results here are labelled x64. | an arm64 run on mercury |

## #26 Public add-on API

The TypeScript surface, the lifecycle, the events and diagnostics, the component hooks and the query API are done and tested in node against the hermetic range origin. What I could not do for real here:

- **Rolled-up `dist/index.d.ts`.** The committed API report is built from the emitted per-module declarations of the public names, and a test scans it for `any` and for imports outside the package (only `maplibre-gl`, a peer, is allowed). A single rolled-up file needs a bundler step, which belongs to the packaging work (M7.6).
- **Layer wiring.** `render`, the context-loss rebuild, worker termination, WASM drop and the query engine are hooks (`src/layer/internal.ts`) that the layer calls in the documented teardown order, and the tests drive them with stubs. The real decoder, buffer pool and stroke renderer are not connected to the layer yet, so the snapshot match after a forced `WEBGL_lose_context`, the 20 sequential maps with a heap ceiling and the live `Worker` and `WebGLBuffer` counts on a real map need that wiring and a browser run (Playwright through the lock, the harness from #10).
- **`capabilities` payload.** It carries the reader floor and the capability list. The container version and profile version fields wait for the frozen layout (P1.8) and the profile in libviprs/pvec#1.
- **Known-truth ids.** The query tests check ids against a table in the test, not against `expected.math.json`, because the shared evaluator and spatial index (`P5.1`, `P7.2`) have no released WASM artifact. The ids come through the `QueryEngine` seam, so swapping the real index is local.
- **Registering a hook after `onAdd` re-renders only affected blocks.** The layer reports which kind changed (`onComponentChange`); counting updated GPU buffers needs the renderer.
- **Example bundle scan.** `examples/01-minimal` and the emitted-bundle scan for text and hatch identifiers wait for the bundling work (M7.6). Today the test walks the import graph of `src/index.ts` and shows no file under `src/style`, `src/text` or `src/hatch` is reachable, and the package `exports` map lists them as separate entries.
- **Weak-reference check after GC.** The emitter keeps no payloads by construction (it stores listeners only); the check runs without `--expose-gc` and is structural.
- **CI regeneration of the API report.** Actions is off; the test rebuilds the report and fails on any diff, and the local gate runs it.

## #58 Deferred curves and progressive refinement

What is done and tested in Node (see `tests/unit/refine/`): the packed batch interface and capability refusal, curve data validation (weights, knots, trims), the worker pool (transfer, detach assertions, buffer recycling, optional shared memory, cancellation), the policy with its hysteresis and per-frame budget, the cost-aware queue, generation replacement with the race harness and its named mutation, the refinement cache with envelope-based hits, the flag-gated WebGPU probe, and a virtual-time interaction stress run for all five scenarios (`bench/out/interaction-stress.json`).

What I could not do here, and what unblocks it:

- **The real evaluator.** Everything codes against `CurveEvaluator` with a Bezier test double that lives under `tests/`. There is no released `pvec` WASM artifact (`P7.2`, `P7.3`), so these acceptance numbers are not measured on real geometry: the known-truth points, domains, trims, derivatives and bounds from `expected.math.json` for all five families inside `P1.2`'s tolerances, rational weight ratios up to 1e3 and triple knots evaluating (they are accepted by the validator, never evaluated), and per-call overhead below 2 percent of evaluation time. `src/workers/evaluator.ts` batches 4,096 parameters per call, which is checked, but the overhead ratio needs the artifact. A real worker entry point is `installWorker(self, factory)`; the factory that instantiates the module is the part that waits.
- **Cost model calibration.** `QUEUE_DEFAULTS.nsPerCostUnit` is a placeholder until M1.3 can be measured on the real evaluator.
- **Real-thread numbers.** Pool saturation (70 percent), the p99 job duration, cancellation waste and the stress run use a virtual clock with workers charged per evaluation, and real add-on CPU time on the main thread. The 4 ms, 12 ms and 33 ms frame budgets are therefore the add-on's own CPU cost in Node, not browser frame times with a compositor. `tests/browser/stress/interaction.spec.ts` (60 second runs on a live MapLibre map) needs the custom layer from #50 and the Playwright CI from #10, and a reference machine. Not written.
- **COOP/COEP CI job.** The pool is exercised with `crossOriginIsolated === false`, and the shared path is compared byte for byte against the transferable path, but the header-free browser job (M2.8) does not exist yet.
- **Convergence wording.** The issue says every visible curve measures at or below 0.5 px two seconds after the camera stops, and also asks for a 4x band between coarsen (0.25) and refine (1.0). Those disagree for a curve sitting at 0.7 px. I kept the band, which the oscillation test needs, so the stress run asserts at most 1.0 px (the refine threshold) and records the fraction at or below 0.5 in the output. The zoom-in test, where every curve is retessellated, does assert 0.5.
- **Coarsening.** The policy reports `coarsen` and the refiner counts the candidates, but it does not queue a job for them: a coarsen job would break the oscillation test and the saving is memory, which the cache ceiling already bounds. Replacing the displayed buffer with a cheaper one is not implemented.
- **GPU upload.** `Refiner` stages draw records through `DrawTable` and calls an `onUpload` hook. The hook is the GPU write; wiring it to the buffer pool and the custom layer belongs to #50's layer work, as does the on-screen snapshot comparison for "no stale frame". Today the check is on the draw table's frame snapshots.
- **WebGPU.** No compute kernel and no throughput numbers (see `docs/adr/webgpu-deferral.md`): no GPU runner, and the kernel is curve mathematics that has to come from `pvec`. The flag, the dynamic import, the `webgpuUnavailable` diagnostic and the WebGL2 fallback are real and tested. The required-jobs test reads `tools/gate.sh` and `.github/workflows`, since the M2.8 job list does not exist yet.
- **Policy order.** The sweep visits entities by descending area and re-sorts at the end of each full sweep, so the order lags the camera by one sweep. The 1 ms budget is measured on 1e6 entities; the sort itself runs outside the frame.
