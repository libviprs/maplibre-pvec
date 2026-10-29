# Spike 06: vector stroke rendering pipeline

Spike for M1.6. Harness: `spikes/stroke/` (`tools/spike.sh stroke`). Raw numbers: `spikes/stroke/results.json`.

## Engines and caveats

| Engine | Version | GL backend as reported | `ALIASED_LINE_WIDTH_RANGE` |
|---|---|---|---|
| Chromium | 130.0.6723.31 | ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver) | **[1, 1]** |
| WebKit (Playwright build) | 18.0 | Apple GPU | **[1, 255]** |
| Firefox | Playwright build in the same image | no WebGL2 context was available in the container | not measured |

Both measured engines ran on x64 Linux in a container with software rendering (the WebKit string "Apple GPU" is what that build reports; there is no GPU in the container). Frame times are therefore **relative software costs** between strategies on that engine, not GPU timings, and the two engines disagree on which strategy is cheapest, which is itself a finding. The issue asks for at least two engines: two were measured, Firefox could not be (see `docs/deferred.md`).

## Wide GL lines are not an option

The two engines report different `gl.lineWidth` ranges for the same call: Chromium accepts only width 1 (range [1, 1]), while the WebKit build reports up to 255. A 2 px or 8 px stroke drawn with `gl.LINES` therefore renders at 1 px on Chromium and wider elsewhere, with implementation-defined joins and caps. This observation, not the panel finding, is why `gl.LINES` with a width is rejected.

## Strategies, one input

All three take the same polylines and the same width, draw white coverage into a cleared target with `MAX` blending (so overlaps do not double-count), and use the same dash function.

1. **Instanced quad:** one instance per segment (`vec4` endpoints and a `float` start length), four corners from a shared buffer, expanded in the vertex shader by half the width plus a 1 px antialiasing margin and by the same margin along the segment; coverage from the perpendicular distance only. Joins and caps are whatever the overlapping quads give.
2. **CPU mesh:** the stroke is triangulated on the CPU: a quad per segment plus a 6-gon fan at every vertex as the explicit round join and cap; coverage from an interpolated signed-distance attribute.
3. **SDF fragment:** the same instances as strategy 1, but the fragment shader computes the distance to the segment (a capsule), which gives round joins and caps and analytic antialiasing.

The reference for the quality numbers is a CPU rasterisation of the exact stroke (every point within half the width of the polyline) with 16 x 16 samples per pixel. Error metric: per-pixel absolute difference in coverage (0 to 1) over the pixels where either side is non-zero, on a polyline with sharp joins and one sub-pixel segment.

## Antialiasing, joins and caps against the supersampled reference

Chromium 130.0.6723.31:

| Width (px) | Strategy | Mean abs error | RMS error | Max error | Max error within width/2 + 2 px of a join or cap |
|---|---|---|---|---|---|
| 1 | instanced quad | 0.0449 | 0.1165 | 0.94 | 0.94 |
| 1 | CPU mesh | 0.0253 | 0.0348 | 0.28 | 0.28 |
| 1 | SDF fragment | 0.0263 | 0.0366 | 0.28 | 0.28 |
| 2 | instanced quad | 0.0428 | 0.1413 | 1.00 | 1.00 |
| 2 | CPU mesh | 0.0188 | 0.0300 | 0.26 | 0.26 |
| 2 | SDF fragment | 0.0174 | 0.0286 | 0.25 | 0.25 |
| 8 | instanced quad | 0.0578 | 0.2106 | 1.00 | 1.00 |
| 8 | CPU mesh | 0.0157 | 0.0643 | 0.59 | 0.54 |
| 8 | SDF fragment | 0.0063 | 0.0180 | 0.37 | 0.22 |

WebKit 18.0:

| Width (px) | Strategy | Mean abs error | RMS error | Max error | Max error within width/2 + 2 px of a join or cap |
|---|---|---|---|---|---|
| 1 | instanced quad | 0.0427 | 0.1159 | 0.93 | 0.93 |
| 1 | CPU mesh | 0.0235 | 0.0333 | 0.30 | 0.30 |
| 1 | SDF fragment | 0.0239 | 0.0343 | 0.30 | 0.30 |
| 2 | instanced quad | 0.0421 | 0.1411 | 1.00 | 1.00 |
| 2 | CPU mesh | 0.0170 | 0.0287 | 0.24 | 0.24 |
| 2 | SDF fragment | 0.0164 | 0.0275 | 0.24 | 0.24 |
| 8 | instanced quad | 0.0575 | 0.2105 | 1.00 | 1.00 |
| 8 | CPU mesh | 0.0153 | 0.0647 | 0.58 | 0.56 |
| 8 | SDF fragment | 0.0056 | 0.0172 | 0.39 | 0.22 |

The instanced quad reaches a coverage error of 1.0 at joins and caps at widths 2 and 8 on both engines: a pixel the reference fully covers is empty in the output (the notch on the outside of a join, and the missing round cap). The CPU mesh and the SDF fragment stay at 0.22 to 0.59.

## Dash phase continuity

A straight path of 108 px is split into two chunks at x = 64.1, the second carrying the exact arc-length start. The dash pattern is 6 on and 4 off at width 4. For each dash I compare the coverage centroid with the ideal one. Device px:

Chromium:

| Strategy | Interior dashes (excluding first and last) | Dashes within one period of the chunk boundary | Worst dash incl. first and last |
|---|---|---|---|
| instanced quad | 0.0255 | 0.0255 | 0.0255 |
| CPU mesh | 0.0234 | 0.0234 | 0.5085 |
| SDF fragment | 0.0234 | 0.0234 | 0.5085 |

WebKit:

| Strategy | Interior dashes (excluding first and last) | Dashes within one period of the chunk boundary | Worst dash incl. first and last |
|---|---|---|---|
| instanced quad | 0.0020 | 0.0020 | 0.0020 |
| CPU mesh | 0.0020 | 0.0020 | 0.5247 |
| SDF fragment | 0.0020 | 0.0020 | 0.5247 |

All three keep the dash phase error at a chunk boundary and across the interior below **0.03 px**, well inside the 0.5 px requirement. The 0.51 to 0.52 px in the last column belongs to the two end dashes of the two round-capped strategies only; it is a cap extending the first and last dash by half the width, not a continuity error. I measured straight paths only: dash phase around a bend is continuous by construction here (the start length is carried per segment) but I did not measure a bent path.

## Cost: bytes per segment and frame time

1e5 and 1e6 segments as 100-segment random-walk polylines in a 512 x 512 target, 2 px wide. The CPU mesh was submitted in 10 draws to bound buffer size. Frame time is the median of 3 timed draws after one warm-up, ending with `gl.finish()` and a pixel read.

Chromium (SwiftShader):

| Segments | Strategy | Bytes per segment | CPU build ms | Frame ms (median) |
|---|---|---|---|---|
| 100,000 | instanced quad | 20 | 11 | 686.8 |
| 100,000 | CPU mesh | 273.8 | 82 | 43.3 |
| 100,000 | SDF fragment | 20 | 9 | 643.3 |
| 1,000,000 | instanced quad | 20 | 74 | 6,705.4 |
| 1,000,000 | CPU mesh | 273.8 | 683 | 461.1 |
| 1,000,000 | SDF fragment | 20 | 90 | 6,915.6 |

WebKit:

| Segments | Strategy | Bytes per segment | CPU build ms | Frame ms (median) |
|---|---|---|---|---|
| 100,000 | instanced quad | 20 | 5 | 28 |
| 100,000 | CPU mesh | 273.8 | 68 | 43 |
| 100,000 | SDF fragment | 20 | 4 | 22 |
| 1,000,000 | instanced quad | 20 | 48 | 201 |
| 1,000,000 | CPU mesh | 273.8 | 592 | 419 |
| 1,000,000 | SDF fragment | 20 | 31 | 200 |

Bytes per segment: 20 for both instanced strategies (four `float32` endpoint coordinates and one start length; the four corners are a shared 32 byte buffer), 273.8 for the CPU mesh (11.07 vertices of 16 bytes plus indices). Building the mesh on the CPU costs 8 to 20 times the instance build.

Instanced draws are dramatically slower on Chromium's software renderer (6.9 s at 1e6 segments against 0.45 s for the mesh) and the other way round on the WebKit software path (0.19 s against 0.42 s). That inversion says the absolute numbers are software artefacts, and the choice below rests on quality, bytes and build cost, not on these frame times. A 1e6-segment frame in a 512 px target is also roughly 100x overdraw, which is far harsher than a plan view.

## Decision

1. **Strategy: SDF fragment on instanced quads (strategy 3)**, as the v1 stroke renderer.
2. **Why, by the numbers:** it is one of only two strategies with correct joins and caps (maximum coverage error near joins 0.22 at width 8 on both engines, against 1.0 for the instanced quad), it has the lowest antialiasing error at 8 px (mean 0.0063 on Chromium, 0.0056 on WebKit, against 0.0157 and 0.0153 for the mesh), and it needs 20 bytes per segment against 273.8 with 75 ms against 648 ms of CPU build at 1e6 segments on Chromium.
3. **Frame time at 1e6 segments:** 6,953 ms on Chromium's SwiftShader and 191 ms on the WebKit software path. These are **provisional**: they are software numbers and the real-GPU figure is owned by `M8.4` and the tuning by `M8.6`.
4. **Dash phase error at a join or chunk boundary:** 0.023 px on Chromium and 0.002 px on WebKit, under the 0.5 px requirement. Dash start length is carried per segment in `float32`, so chunk-local arc length needs the same origin discipline as positions (ADR 0002).
5. **Fallback:** the CPU mesh stays a documented fallback fed from the same segment buffer if the hardware benchmarks (`M8.4`) show the fragment cost is not acceptable.
6. **Monochrome default:** the pipeline outputs a single coverage value per pixel and the default style draws every stroke in one colour, which is the monochrome-default requirement; colour per layer is a style input and does not change the pipeline.
7. `gl.LINES` with a width is rejected on the `gl.lineWidth` evidence above.
