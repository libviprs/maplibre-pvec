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
