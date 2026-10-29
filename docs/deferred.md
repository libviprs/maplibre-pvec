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

## #31 package, compatibility matrix and examples

What is done and tested: the ESM-only package output (five entries with an exports map, `typesVersions` for node10, bundled JS with one shared chunk, rolled-up `.d.ts`, the `.wasm` asset inside the tarball, no dependencies, no install scripts), the three WASM acquisition modes with `wasm_unavailable` on every failure and no fallback, the transport choice (shared memory only when `crossOriginIsolated`), `docs/deployment/csp.md`, the compatibility matrix generated from one source (`src/compat/matrix.ts`) with the peer range derived from it and checks for drift, WebGPU, the single baseline and a test per refusal row, `publint --strict` and `arethetypeswrong` with no problems, a clean-directory install of the tarball, and `examples/01-minimal` run in headless Chromium under the CSP from the issue, without `'wasm-unsafe-eval'`, and with the `.wasm` request aborted. `tools/pack.sh` and `tools/examples.sh` run all of it in containers.

| Item | Why it cannot be done here | What unblocks it |
|---|---|---|
| The shipped `pvec_eval.wasm` is a 68-byte boundary probe (exports `pvec_abi_version`), not the evaluator | `libviprs/pvec` has no WASM build of the evaluator (see issue 2 above). `scripts/build.mjs` copies `$PVEC_WASM` over the probe when it is set | The `pvec` evaluator artifact. Set `PVEC_WASM`, re-run `tools/pack.sh`; the ABI check in `loadEvaluator` then guards the real export set |
| "A test installs the tarball and renders a fixture headlessly" | There is no custom layer to render with (`onAdd`, M7.1/M7.2 belong to the public API issue). The install test loads the evaluator and opens the container from the installed tarball, and `01-minimal` does the same in a browser | The custom layer; extend `01-minimal` to add the layer and read pixels |
| `onAdd` rejects with `wasm_unavailable`, exactly one `error` event, MapLibre layers keep rendering | Needs `onAdd`. `loadEvaluator` already rejects with that code and `01-minimal` asserts it in a browser | The custom layer and its failure path |
| Examples 02 to 06 and the CI job over all six | They need the custom layer (02), the refinement stream (03), a renderer and a heap and GPU budget (04), picking on screen (05), hot calibration on screen (06), and the known-truth `.pvec` files with `expected.math.json` (no `.pvec` exists in `pvec-gold-fixtures` yet) | The layer, the Tier 0 stream, the gold corpus. `examples/lib/serve.mjs`, `examples/generate-large.mjs` and `examples/run-all.sh` are the harness they plug into |
| Firefox and WebKit rows of the browser axis, Chromium minimum below 130, MapLibre highest/lowest in the browser grid | The CI container's Firefox has no WebGL2, no grid exists yet (the conformance suite is its own issue), and only 130 was run | A browser grid with pinned Firefox and WebKit. The matrix lists both as `pending`, and a supported row missing from the grid already fails a check |
| The capability refusal code is `required-unsupported` / `required-version`, not `unsupported_required_capability` | The code shipped with the remote source before this matrix; renaming it is a breaking change for its tests | A decision on the name; the matrix documents the as-built codes |
| Informational COOP/COEP-isolated conformance run | The conformance suite does not exist yet. The default path never sets the headers, and `01-minimal` asserts `crossOriginIsolated === false` and `transfer` | The conformance suite |
| Publishing | Out of scope (M8.7). `private` stays `true` and nothing is pushed anywhere | The release issue |
