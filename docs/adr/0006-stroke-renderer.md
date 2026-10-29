# ADR 0006: Stroke renderer

- Status: Accepted
- Date: 2026-10-29
- Evidence: `docs/spikes/06-stroke.md`

## Context

A plan viewer's output is almost entirely strokes. The strategy was chosen by measuring three options on identical input in two engines.

## Decision

1. The v1 stroke renderer is **instanced quads with a signed-distance (capsule) fragment shader**: one 20-byte instance per segment, round joins and caps, analytic antialiasing, dash phase from a per-segment start length.
2. `gl.LINES` with a width is not used. `gl.lineWidth` is implementation-defined: Chromium reported a range of [1, 1] and the WebKit build [1, 255].
3. The default style is monochrome: the pipeline emits a single coverage value, and every stroke in the default style is one colour.
4. The CPU-triangulated mesh stays a documented fallback fed from the same segment buffer.

Evidence (against a 16 x 16 supersampled reference):

- Maximum coverage error near joins and caps at 8 px width: 0.22 for the SDF fragment, 0.54 (Chromium) and 0.56 (WebKit) for the CPU mesh, and 1.0 for the instanced quad, which leaves a notch on the outside of every join.
- Mean antialiasing error at 8 px: 0.0063 (Chromium) and 0.0056 (WebKit) for the SDF fragment, 0.0157 and 0.0153 for the mesh.
- Dash phase error across a chunk boundary: 0.023 px (Chromium) and 0.002 px (WebKit), under the 0.5 px requirement.
- 20 bytes per segment against 273.8 for the mesh; CPU build 75 ms against 648 ms per 1e6 segments (Chromium).
- Frame time at 1e6 segments: 6,953 ms on Chromium's SwiftShader and 191 ms on the WebKit software path. **Provisional**: software numbers, and the real-GPU figure and tuning belong to `M8.4` and `M8.6`.

## Consequences

- Fragment cost scales with covered pixels, so dense plans at low zoom are the case to benchmark on a GPU (`M8.4`); the fallback exists for that reason.
- Dash length is `float32` per segment, so arc length is kept chunk-relative under ADR 0002.
- Hatch and text are out of scope here.
