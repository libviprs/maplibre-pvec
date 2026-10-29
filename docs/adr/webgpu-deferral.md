# ADR: WebGPU stays experimental behind a flag

- Status: Accepted
- Date: 2026-10-29
- Builds on: ADR 0008 (deferral policy) and `docs/spikes/07-workers-webgpu.md`

## Context

WebGL2 is the v1 rendering baseline because it is the context MapLibre's custom-layer interface hands out (4.7.1, 5.24.0 and 6.16.0, observed in `docs/spikes/01-maplibre-surface.md`). No version hands out a GPU device, so there is nothing for a WebGPU renderer to attach to.

## Decision

`experimental.webgpu` is an option, off by default. The code lives under `src/experimental/webgpu/` and is only reached through a dynamic import in `src/refine/backend.ts`, so the default bundle has none of it (a test builds the entry with code splitting and scans it for `navigator.gpu`, `requestAdapter`, `GPUDevice` and `webgpuUnavailable`). With the flag on and no usable adapter, tessellation stays on the worker and WASM path, rendering stays on WebGL2, and `webgpuUnavailable` is reported once per diagnostics sink.

What I built is the probe and the fallback. I did not build the compute kernel: a tessellation kernel is curve mathematics, which has to come from PVec's evaluator rather than a shader written here, and I have no GPU to run it on. A present adapter therefore still reports `kernel-not-built`.

## Measurement

| Path | Fixture | Throughput | Source |
|---|---|---|---|
| Worker plus transferable buffers, 1 worker | 48 jobs of 50,000 segments (stand-in workload) | 29,197 thousand segments/s | spike 07 |
| Worker plus transferable buffers, 8 workers | same | 98,360 thousand segments/s | spike 07 |
| WebGPU compute, including transfer and readback | same | not measurable: headless Chromium 130 has `navigator.gpu` but `requestAdapter()` returned null | spike 07 |

The WebGPU row stays empty until a GPU-backed runner exists (`docs/deferred.md`). The worker numbers are for the stand-in workload and get re-measured with the real evaluator.

## Promotion criteria

Promoting WebGPU to a supported backend would be a decision against these, after phase 8. Each is testable.

1. MapLibre exposes a stable, documented way for a custom layer to obtain a GPU device, shown by the surface probe in each supported MapLibre version.
2. A WebGPU adapter is available in every browser of the supported matrix (M7.7), recorded by the compatibility run.
3. On the named spline-heavy fixture, WebGPU tessellation including transfer and readback reaches at least 2.0 times the throughput of the worker pool at the default worker count (4).
4. Its output is identical to the WebGL2 path within the shared numeric policy's tolerances (`P1.2`), measured per fixture.

## Consequences

- No gate depends on WebGPU. A test fails if the local gate script or any workflow file mentions it.
- A browser without WebGPU, with the flag on, renders every frame through WebGL2 and says so once.
