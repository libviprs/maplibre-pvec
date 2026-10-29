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

### Measurements

The benchmark numbers are display-fidelity and frame-behaviour measurements on software GL (SwiftShader, native x86_64), recorded as relative costs. They say nothing about geometric accuracy. The mathematical tolerances and the three conformance classes belong to EPIC P and the shared numeric policy in `libviprs/pvec#1`, and I cite them rather than restate them. The numbers are in `docs/benchmark-report.md`.

### Not in this release candidate

The real PVec WASM evaluator, hardware GPU numbers, Firefox and WebKit rows, examples 02 to 06 and the context-loss snapshot are listed in `docs/deferred.md`.
