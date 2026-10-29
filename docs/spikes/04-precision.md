# Spike 04: deep-zoom precision strategy

Spike for M1.4. Harness: `spikes/precision/` (`tools/spike.sh precision`). Raw numbers: `spikes/precision/results.json`.

This spike measures a **display fidelity** budget in device pixels. It defines no mathematical tolerance and no epsilon; the numeric policy is `P1.2` in `libviprs/pvec#1` and this repository adds nothing to it. Nothing below is a statement of mathematical exactness, only of where a vertex lands on screen.

## Method

I ran the real vertex shader on the GPU path (WebGL2, ANGLE on SwiftShader, Chromium 130.0.6723.31, x64 container) and captured its `float32` output with transform feedback, so there is no rasterisation snapping in the numbers. The output is compared with the position computed in `f64` in JavaScript. Camera sweep: 64 steps of 0.1 device px each, per case. For each vertex in view:

- **Static deviation** is the largest distance from the `f64` position over the sweep (device px).
- **Pan jitter** is the largest change in that error between two consecutive 0.1 px camera steps.

The shader's `highp float` has 23 bits of mantissa on this renderer (`getShaderPrecisionFormat`).

Strategies, all through the same camera path (`screen = (vertex - camera) * pixelsPerUnit`):

1. **naive:** world coordinates narrowed to `float32` on upload, camera as a `float32` uniform.
2. **local:** chunk origin `O` (an `f64`); vertices uploaded as `float32(P - O)`; the camera-relative translation `O - C` is computed on the CPU in `f64` and uploaded as a `float32` uniform.
3. **hilo:** as strategy 2, but the vertex offset and the translation are each carried as a high and a low `float32` (a double-single split) and recombined in the shader as `(hi + hi') + (lo + lo')`.

Geometry at coordinate magnitudes 1e3, 1e6 and 1e7 source units, placed 5,000 units (500 at 1e3) inside a chunk whose origin is at the magnitude: a **1 mm segment**, a **1 mm radius arc** sampled at 32 points, and **nine control points** spread over the chunk standing in for a NURBS control polygon with a full-extent span. These are points, not curves. I evaluated no curve in this spike. Deepest pixels-per-unit: 16,384 (a 1 mm feature is 16 px wide).

## Results

Cell = worst static deviation / worst pan jitter, in device pixels, across the three shapes. "Zoom" is the MapLibre zoom whose ground resolution at the equator equals one pixel at that scale (MapLibre's world is 512 px at zoom 0, and its own maximum zoom is 24).

| Magnitude (units) | Pixels per unit | Zoom (equator) | naive | local | hilo |
|---|---|---|---|---|---|
| 1,000 | 1 | 16.3 | 0.00015 / 0.0001 | 3.7e-05 / 2.5e-05 | 8.3e-06 / 1.3e-05 |
| 1,000 | 16 | 20.3 | 0.0024 / 0.0022 | 0.00063 / 0.00055 | 3.2e-07 / 5.4e-07 |
| 1,000 | 256 | 24.3 | 0.039 / 0.026 | 0.009 / 0.0064 | 3.1e-07 / 5.4e-07 |
| 1,000 | 4,096 | 28.3 | 0.55 / 0.41 | 0.13 / 0.1 | 4.8e-07 / 6.9e-07 |
| 1,000 | 16,384 | 30.3 | 2.5 / 1.9 | 0.48 / 0.41 | 9.3e-07 / 1.6e-06 |
| 1,000,000 | 1 | 16.3 | 0.041 / 0.053 | 0.00047 / 0.0004 | 3.1e-07 / 5.4e-07 |
| 1,000,000 | 16 | 20.3 | 0.89 / 0.91 | 0.0073 / 0.0064 | 3.2e-07 / 5.4e-07 |
| 1,000,000 | 256 | 24.3 | 13 / 16 | 0.13 / 0.1 | 3.2e-07 / 5.5e-07 |
| 1,000,000 | 4,096 | 28.3 | 13 / 0.14 | 2.4 / 1.9 | 4.8e-07 / 4.8e-07 |
| 1,000,000 | 16,384 | 30.3 | 24 / 0.14 | 10 / 7.9 | 0 / 0 |
| 10,000,000 | 1 | 16.3 | 0.93 / 0.91 | 0.00047 / 0.0004 | 3.1e-07 / 5.4e-07 |
| 10,000,000 | 16 | 20.3 | 15 / 16 | 0.0073 / 0.0064 | 3.2e-07 / 5.5e-07 |
| 10,000,000 | 256 | 24.3 | 9.5 / 0.14 | 0.13 / 0.1 | 0 / 0 |
| 10,000,000 | 4,096 | 28.3 | 13 / 0.14 | 2.4 / 1.9 | 0 / 0 |
| 10,000,000 | 16,384 | 30.3 | 24 / 0.14 | 10 / 7.9 | 0 / 0 |

Reading it:

- **naive fails.** At 1e6 units and 256 px/unit the static deviation is 13 device px and the jitter 16 device px (both far above 1). At 1e7 units it is already 0.93 px at 1 px/unit and 15 px at 16 px/unit. At 1e6 and 4,096 px/unit the 1 mm segment's drawn length is 0 px against an ideal 4.096 px: the feature collapses to nothing.
- **local alone is not enough at deep zoom.** It is exact enough until the chunk offset (5,000 units) times the `float32` epsilon shows through: 2.4 px at 4,096 px/unit and 10 px at 16,384 px/unit for 1e6 and 1e7 magnitudes. The 1 mm segment's drawn length is off by 0.096 px against an ideal of 4.096 px at 4,096 px/unit, but its position is off by 1.5 px.
- **hilo holds the whole sweep.** Worst static deviation anywhere in the sweep: **8.3e-6 device px**; worst pan jitter **1.3e-5 device px**. Both are far below 0.5 px, over all 15 magnitude and scale combinations and all three shapes.

## Cost of the chosen strategy

| Strategy | Attribute bytes per vertex | Upload of 1e6 vertices (median of 8, `bufferData` + `finish`) |
|---|---|---|
| naive | 8 | 0.5 ms |
| local | 8 | 0.5 ms |
| hilo | 16 | 1.2 ms |

So the hilo split costs +8 bytes per vertex (twice the attribute size) and +0.7 ms per million vertices on this software renderer. A software renderer's upload time is a memory copy, so I treat the ratio as indicative only.

## Caveats the ADR must carry

- The transform-feedback probe measures the vertex shader's subtract-and-scale step, which is where the `float32` damage happens. It does **not** include MapLibre's own projection matrix chain. The production path (`M4.5`) has to fold the translation into the matrix on the CPU in `f64` (the 4.7.1 matrix argument is a plain JS array of doubles, spike 01) and confirm the same figures end to end.
- The shader recombination `(hi + hi') + (lo + lo')` relies on the compiler not reassociating. It held on this renderer. Other drivers can reassociate, so it needs the real-GPU check that is deferred in `docs/deferred.md`.
- Everything is display fidelity. Canonical coordinates stay `f64` and analytic.

## Decision

1. **Precision model: chunk-local origins plus a high/low (double-single) split.** CPU computes camera-relative translation in `f64` per chunk and per frame; vertices carry `hi` and `lo` `float32` offsets from the chunk origin.
2. **Per-vertex attribute cost: 16 bytes** (4 `float32`) for position, against 8 for the naive layout. Measured upload delta: +0.7 ms per 1e6 vertices (software GL).
3. **Display budget: 0.5 device px** for static deviation and for pan jitter. Measured hilo: 8.3e-6 px and 1.3e-5 px.
4. **Envelope the add-on promises:** coordinate magnitude up to **1e7 source units**, scale up to **16,384 px per unit** (zoom 30.3 at the equator, which is 6 zoom levels beyond MapLibre's maximum of 24), vertex offsets up to **5,000 units** from the chunk origin. Beyond any of these I measured nothing and the add-on refuses to promise stability. Larger chunk offsets are expected to behave better under hilo than under local, but that is untested.
5. The naive and local-only strategies are rejected by the numbers above, not by preference.
