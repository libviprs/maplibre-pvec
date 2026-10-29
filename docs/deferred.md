# Deferred work

Things that cannot be done for real in this repository today, each with the reason and what unblocks it.
Append a section per issue.

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
| Transform and display pipeline suite (`M2.5`) | The georeference contract, projection adapter and screen-space error evaluator are not implemented. Registered as pending gate `pipeline`. | #42 (M4.1, M4.2, M4.4) |
| Tier 0 preview and refinement suite (`M2.6`) | There is no Tier 0 decoder or refinement scheduler to drive. Registered as pending gate `tier0`. | #50 (M5.1) and the refinement issues |
| Parser and range security suite (`M2.7`) | It needs the browser reader and the limits from `M3.1`/`M3.6`. Registered as pending gate `hostile-input`. | #18, `libviprs/pvec#1` P4.7, P4.8 |
| Real-world dual-oracle fixtures (`M2.2`) | The corpus has no `DUAL_ORACLE_EQUIVALENT` or `REAL_WORLD_DIFFERENTIAL` fixture yet (a second converter has not run). The registry, gating rule and claim table already handle both classes and are tested with reclassified fixtures. | `libviprs/pvec-gold-fixtures` second-oracle route |
| Snapshot baselines keyed by renderer string (`M2.8`) | There is nothing rendered to snapshot. The job exists and reports pending. | #50 |
| Origin as a separate container, x64 labelling on arm64 default | The origin is a loopback Node process started and stopped by Playwright inside the same throw-away container as the run, which is hermetic but not a second container. The gate ran on the x64 docker host only, so results here are labelled x64. | an arm64 run on mercury |
