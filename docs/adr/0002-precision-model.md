# ADR 0002: Precision model

- Status: Accepted
- Date: 2026-10-29
- Evidence: `docs/spikes/04-precision.md`

## Context

GPU `float32` cannot carry a site-scale coordinate and a millimetre feature together. The numeric policy for PVec is `P1.2` in `libviprs/pvec#1`. **This repository defines no epsilon or mathematical tolerance of its own.** What it owns is a display-fidelity budget in device pixels, and none of the numbers below are claims of mathematical exactness.

## Decision

Chunk-local origins with the camera-relative translation computed on the CPU in `f64`, plus a high/low (double-single) split carried in two `float32` attributes per coordinate.

- Display budget: 0.5 device px for both static deviation and pan jitter.
- Measured with the hilo strategy across magnitudes 1e3, 1e6 and 1e7 source units, 1 to 16,384 px per unit, and a 1 mm segment, a 1 mm arc and a full-extent control polygon: worst static deviation 8.3e-6 px, worst pan jitter 1.3e-5 px.
- The naive strategy (world coordinates narrowed to `float32`) fails the budget: 13 px deviation and 16 px jitter at 1e6 units and 256 px/unit.
- Local origin alone also fails at depth: 2.4 px at 4,096 px/unit and 10 px at 16,384 px/unit, because the 5,000 unit chunk offset meets the `float32` epsilon.
- Per-vertex position cost: 16 bytes against 8. Measured upload delta: 1.2 ms against 0.5 ms per 1e6 vertices on software GL.
- Supported envelope: magnitude up to 1e7 source units, up to 16,384 px per unit, vertex offsets up to 5,000 units from the chunk origin. Outside it the add-on does not promise stability.

## Consequences

- Chunk size and the origin rule are tuning values for phase 8 (`M8.6`) and are **provisional**; only the strategy is frozen here.
- The probe measured the vertex shader's subtract-and-scale step on SwiftShader. `M4.5` must prove the same budget through MapLibre's matrix chain and on a real GPU, in particular that the driver does not reassociate the `hi`/`lo` sum.
- Canonical curves stay analytic in `f64`; only display buffers narrow to `float32`. Reports and docs call the results display fidelity.
