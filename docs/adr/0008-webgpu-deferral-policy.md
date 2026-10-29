# ADR 0008: WebGPU deferral policy

- Status: Accepted
- Date: 2026-10-29
- Evidence: `docs/spikes/07-workers-webgpu.md`, `docs/spikes/01-maplibre-surface.md`

## Context

MapLibre's custom-layer surface hands out a `WebGL2RenderingContext` in 4.7.1, 5.24.0 and 6.16.0 (observed in each), and no version handed out a GPU device. WebGPU in the browsers I could probe is not a dependable baseline.

## Decision

WebGPU is deferred. **v1 correctness and release do not depend on WebGPU**: no feature, test or release gate requires it, and the WebGL2, Web Workers and WASM path is complete without it.

Evidence: in headless Chromium 130 `navigator.gpu` exists but `requestAdapter()` returned `null`, so no WebGPU tessellation time exists to compare with the worker pool's 98,360 thousand segments/s at 8 workers. The other engines were not probed.

**Trigger for reconsideration:** revisit when both hold: (a) MapLibre exposes a stable, documented way for a custom layer to obtain a GPU device (today none of the three versions I tested does), and (b) a WebGPU adapter is available in the browsers in the supported matrix and a tessellation probe on real hardware beats the worker path by a margin that justifies a second renderer. Until both hold, any WebGPU work is an experimental, opt-in module.

## Consequences

- No WebGPU code in the main package; any experiment sits behind an explicit flag and cannot change a default.
- The compute probe on real hardware is recorded as deferred in `docs/deferred.md`.
- This ADR is revisited by `M8.6` and `M8.7` only.
