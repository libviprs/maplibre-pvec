# Changelog

Versioning follows semver for the public surface in `etc/maplibre-pvec.api.md`: a new export is a minor change, a removal or a signature change is a major one. `release/v1-freeze.json` pins the surface and `tools/release-gate.mjs` classifies a change against it.

## Unreleased

Nothing is tagged or published. `1.0.0` waits for every condition in `release/v1-gate.json` to be met; see `docs/v1-readiness.md` for what is open.

### Added

- Browser spikes and eight ADRs (MapLibre surface, precision, range, buffers, workers, stroke renderer, Mercator baseline, WebGPU deferral).
- Range source with scheduler, coalescer, cancellation, version checks and three cache tiers.
- GIS transform and precision: georeferencing, Mercator adapter, inverse viewport transform, screen-space error evaluator, high and low coordinate split, culling.
- Tier 0 rendering: packed segments, instanced SDF stroke renderer, buffer pool, picking, GL-state guard.
- Deferred curves and progressive refinement: worker pool, policy, cost-aware queue, generation replacement, refinement cache. WebGPU is a flag that stays off.
- Public add-on API: `createPVecLayer`, events, diagnostics, component hooks, queries.
- Package output, WASM acquisition modes, compatibility matrix and pack check.
- Benchmark corpus, harness and a first committed baseline run.
- Complete documentation set with generated pages (`docs/README.md`), the v1 freeze file and the release gate.
- The shipped `pvec_eval.wasm` is the real `pvec-wasm` evaluator (ABI 1), and `loadEvaluator` refuses a module without its export set. 22 of the 30 corpus fixtures have real `.pvec` bytes from pvec's generator. Spikes M1.2, M1.3 and M1.5 re-run on them.

### Raster names (#104, minor)

A minor change: nothing is removed or retyped. `PVecLayerOptions.raster` and `update({ raster })`, the `rasterskipped` event and `RasterSkippedEvent`, `RasterInfo` and `PVecLayer.rasters()`, and the optional capability `raster` in the compatibility matrix. `DiagnosticsSnapshot.rasters` is added. This is a freeze amendment under the R-M epic (#103). `tools/release-gate.mjs` hashes whole declarations, so it reads each of these additions to an existing declaration as a change to that symbol.

### Raster measurements and the texture constant (#108, display fidelity)

`RASTER_DEFAULTS` in `src/config/defaults.ts` (bytes per texel, the retained-level factor and the texture share of `cache.gpuBytes`) and the same object in `release/v1-freeze.json` are new frozen budgets, equal by test, with the values the raster texture bound already used (4, 2 and 1). Nothing exported changed, so this is a patch-level change to the budgets and not a change to the public surface. The render budget with rasters is 1.5 ms at the 95th percentile on frames that upload no tile, with uploads under the existing 2 ms budget; the issue's 1 ms was not reachable on the Intel row by construction (`docs/adr/0009-raster-quads.md`). The decode, upload and frame numbers for rasters in `docs/benchmark-report.md` are display-fidelity and frame-behaviour measurements, each named with its renderer, engine and arch; the software GL rows are relative costs and feed no budget.

### Measurements

The benchmark numbers are display-fidelity and frame-behaviour measurements on software GL (SwiftShader, native x86_64), recorded as relative costs. They say nothing about geometric accuracy. The mathematical tolerances and the three conformance classes belong to EPIC P and the shared numeric policy in `libviprs/pvec#1`, and I cite them rather than restate them. The numbers are in `docs/benchmark-report.md`.

### Not in this release candidate

The real PVec WASM evaluator, hardware GPU numbers, Firefox and WebKit rows, examples 02 to 06 and the context-loss snapshot are listed in `docs/deferred.md`.
