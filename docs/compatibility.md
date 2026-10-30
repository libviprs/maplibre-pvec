<!-- Generated from src/compat/matrix.ts by npm run compat:generate. Do not edit. -->
# Compatibility

The `maplibre-gl` peer range is `>=4.7.1 <7.0.0`, derived from the lowest and highest tested rows below.

## MapLibre GL JS

| Version | render argument | Context handed to onAdd | Verified |
| --- | --- | --- | --- |
| 4.7.1 | number[16] (the matrix) | WebGL2RenderingContext | onAdd context, matrix convention within 1 device px, state left set |
| 5.24.0 | object with defaultProjectionData.mainMatrix | WebGL2RenderingContext | onAdd context, matrix convention within 1 device px, state left set |
| 6.16.0 | object with defaultProjectionData.mainMatrix (plus getProjectionData) | WebGL2RenderingContext | onAdd context, matrix convention within 1 device px, state left set |

## Browsers

| Engine | Status | Tested | Note |
| --- | --- | --- | --- |
| chromium | supported | 130.0.6723.31 | WebGL2 through ANGLE on SwiftShader in CI; module workers; no COOP/COEP needed |
| firefox | pending | none | the CI container's Firefox returned no WebGL2 context, so no minimum is claimed until the M2.8 grid has a Firefox row |
| webkit | pending | none | no minimum is claimed until the M2.8 grid has a WebKit row |

- webgl2: required, no canvas2D fallback
- wasmFeatures: WebAssembly MVP only; no threads, no SIMD, no bulk memory required by the shipped module
- moduleWorkers: required for the worker transfer path
- crossOriginIsolation: never required; shared memory is used only when crossOriginIsolated is true

## PVec

- reader version: 1.0.0
- semantic profile: geometry major 1
- accepted capability major: 1
- required capabilities: cartesian_point, direction_vector, axis_placement_2d, line, polyline, circle, ellipse, trimmed_curve, composite_curve, bezier_curve, b_spline_curve, rational_b_spline_curve, affine_transform_2d
- optional capabilities: layer, line_style, text, hatch, source_provenance, dwg_semantics, semantic_class

## Projections

| Projection | State | Conformance baseline |
| --- | --- | --- |
| mercator | conformant | yes |
| globe | experimental | no |

## Unsupported combinations

| Row | Combination | Code | Outcome |
| --- | --- | --- | --- |
| U1 | MapLibre outside the tested range | `unsupported_maplibre_version` | refuse at attach; the message names the tested range |
| U2 | no WebGL2 context | `webgl2_required` | refuse at attach; no canvas2D fallback |
| U3 | required PVec capability not implemented | `unsupported_required_capability` | refuse before any payload byte; a wrong major of a known capability uses the same code with detail.reason set to version |
| U4 | optional PVec capability not implemented | `degrade` | skip the blocks and list the capability in the bootstrap report |
| U5 | file needs a newer reader than 1.0.0 | `reader-too-old` | refuse before any payload byte |
| U6 | WASM fetch or compile blocked | `wasm_unavailable` | onAdd rejects, one error event, MapLibre layers keep rendering, no TypeScript geometry fallback |
| U7 | projection other than mercator | `UnprovenProjectionError` | refuse at attach unless allowUnprovenProjection is set; results are then non-conformant |

## Experimental (not supported)

- webgpu: not a supported target; v1 does not depend on it (ADR 0008)
