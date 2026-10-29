# Architecture decision records (browser)

Eight ADRs freeze the phase 1 decisions. Each one quotes numbers from a spike report under `docs/spikes/`.

| ADR | Subject | Evidence |
|---|---|---|
| [0001](0001-maplibre-integration-surface.md) | MapLibre integration surface | `docs/spikes/01-maplibre-surface.md` |
| [0002](0002-precision-model.md) | Precision model | `docs/spikes/04-precision.md` |
| [0003](0003-range-model.md) | Range model | `docs/spikes/02-range-bootstrap.md` |
| [0004](0004-buffer-model.md) | Buffer model | `docs/spikes/03-wasm-evaluator.md` |
| [0005](0005-worker-model.md) | Worker model | `docs/spikes/07-workers-webgpu.md` |
| [0006](0006-stroke-renderer.md) | Stroke renderer | `docs/spikes/06-stroke.md` |
| [0007](0007-mercator-conformance-baseline.md) | Mercator conformance baseline | spikes 01 and 04 |
| [0008](0008-webgpu-deferral-policy.md) | WebGPU deferral policy | `docs/spikes/07-workers-webgpu.md` |

## Phase 1 exit criterion

No phase 3 or phase 5 implementation lands before these eight are merged. Anything an ADR marks
provisional is a tuning value the plan defers to phase 8 (`M8.6`), not a frozen number.

## Reading the numbers

Every spike ran in a throw-away container with software GL (SwiftShader for Chromium), so absolute
frame times are relative costs between strategies, not GPU timings. Each report says which engine,
version and platform produced a number. Where a spike needed something that does not exist yet
(the `pvec` evaluator as WASM, a Tier 0 stream) the gap is written down in `docs/deferred.md` and
the ADR that depends on it says so.
