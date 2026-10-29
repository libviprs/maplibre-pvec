# Deferred work

Things that cannot be done for real in this repository today, each with the reason and what unblocks it.
Append a section per issue.

## #42 GIS transform and precision

The pure TypeScript math is done and unit-tested in node. These parts need something I do not have here:

- **MapLibre agreement for the jacobian (M4.2).** The 1e-6 relative check against MapLibre's own projection needs the custom-layer matrices from a live map. Today `jacobianAt` is checked against a finite difference of this repository's own mercator camera. Needs the Playwright harness from #10.
- **GPU measurement of vertex error (M4.5, M4.8).** `docs/precision.md` is measured by emulating the shader with `Math.fround`. The browser matrix (`tests/browser/stress/precision.spec.ts`) and the rendered-snapshot diffs need real WebGL2 contexts, which needs the Tier 0 pipeline from #50 and the Playwright CI from #10. `position.glsl` has not been compiled against a GL context yet.
- **WASM curve evaluation (M4.4, M4.7).** `ScreenErrorEvaluator` and `conservativeScreenBounds` take curves through a `CurveRef` / `CullableEntity` interface. The known-truth families in the tests are small stand-ins, because the shared PVec evaluator WASM artifact and the M2.1 fixtures are not available yet. Wiring the real evaluator is a swap behind that interface.
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
