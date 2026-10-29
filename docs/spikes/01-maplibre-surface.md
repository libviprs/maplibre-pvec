# Spike 01: MapLibre custom-layer surface

Spike for M1.1. Harness: `spikes/maplibre-surface/` (throwaway, nothing promoted into `src/`). Raw numbers: `spikes/maplibre-surface/results.json`. Run with `tools/spike.sh maplibre-surface`.

## Setup

| Item | Value |
|---|---|
| MapLibre GL JS versions | 4.7.1, 5.24.0, 6.16.0 (exact strings from `maplibregl.getVersion()`) |
| Browser | Chromium 130.0.6723.31 (Playwright 1.48.2 image), headless |
| Renderer | ANGLE on SwiftShader (software Vulkan), no GPU, x64 container on the docker host |
| Page | 512 x 512 CSS px, device pixel ratio 1 and 2, Mercator, zoom 14, centre 8.5417, 47.3769 |
| Layer under test | one instrumented quad (60 m wide) at the centre lon/lat, drawn by a custom layer with a trivial program, VBO and VAO |

6.x ships ESM only (`dist/maplibre-gl.mjs`, no UMD bundle), so the harness imports it as a module. 4.x and 5.x use the UMD file. Only Chromium was exercised for this spike, so no other engine is claimed here.

Frame times in this report are the JavaScript time spent inside `render()` (issuing the draw). The software renderer's raster time is not in them and they must not be read as GPU timings.

## 1. `onAdd` / `onRemove`

| | 4.7.1 | 5.24.0 | 6.16.0 |
|---|---|---|---|
| Context handed to `onAdd` | `WebGL2RenderingContext` | `WebGL2RenderingContext` | `WebGL2RenderingContext` |
| Same object as `canvas.getContext("webgl2")` | yes | yes | yes |
| `onAdd` calls observed over the run | 1 per layer add | 1 | 1 |

The context type is an observation: `gl.constructor.name` was `WebGL2RenderingContext` and `gl instanceof WebGL2RenderingContext` was `true` in all three versions at both pixel ratios. Teardown ordering when the context is lost is in section 6 (4.7.1 never called `onRemove`; 5.24.0 and 6.16.0 call it before the `webglcontextlost` event).

## 2. `prerender`

`prerender` ran once per frame, every frame the layer was present: 30 prerenders for 30 `render` calls on-demand, and 180 for 180 in the 3 s self-driven loop, in all three versions. Its arguments are the same as `render`'s (same matrix, or the same args object), so it can be used for work that must happen before the main pass, but it receives nothing extra.

## 3. `render(gl, args)` and the matrix convention

| | 4.7.1 | 5.24.0 | 6.16.0 |
|---|---|---|---|
| Second argument | `number[16]` (the matrix itself) | object | object |
| Object keys | n/a | `farZ, nearZ, fov, modelViewProjectionMatrix, projectionMatrix, shaderData, defaultProjectionData` | the 5.24.0 keys plus `getProjectionData`, `renderTerrainHeightMap` |
| `defaultProjectionData` keys | n/a | `mainMatrix, tileMercatorCoords, clippingPlane, projectionTransition, fallbackMatrix` | those plus `clipAntimeridian` |
| Matrix I used | argument 0 | `args.defaultProjectionData.mainMatrix` | `args.defaultProjectionData.mainMatrix` |

The convention, demonstrated rather than asserted: the matrix takes **Mercator coordinates** (`MercatorCoordinate.fromLngLat`, x and y in [0, 1] with y growing south, z = 0) to clip space. I drew the quad with vertices in those units and read the framebuffer back inside `render`:

| Version | Pixel ratio | Measured quad centroid (device px) | `map.project(lngLat) * dpr` | Distance |
|---|---|---|---|---|
| 4.7.1 | 1 | (256.0, 256.0) | (256, 256) | 0.00 px |
| 4.7.1 | 2 | (512.5, 511.5) | (512, 512) | 0.71 px |
| 5.24.0 | 1 | (256.0, 256.0) | (256, 256) | 0.00 px |
| 5.24.0 | 2 | (512.5, 511.5) | (512, 512) | 0.71 px |
| 6.16.0 | 1 | (256.0, 256.0) | (256, 256) | 0.00 px |
| 6.16.0 | 2 | (512.5, 511.5) | (512, 512) | 0.71 px |

All six are within 1 device pixel. The 0.71 px at pixel ratio 2 is the resolution of my measurement, not drift: the quad covers an odd number of pixels (37 x 37), so its centroid of pixel centres is a half pixel off the exact centre on each axis, and 0.5 px on two axes is 0.71 px.

After `render` returned control, the state MapLibre left set was: blend enabled, depth test enabled. The layer therefore cannot assume a clean state, which the production layer's GL-state hygiene (`M5.7`) has to handle.

## 4. Render ordering and `renderingMode`

I stacked `background`, a red `fill`, a green 40 px wide `line`, and inserted the custom layer (opaque blue) at different positions. Pixel read from the composited canvas, centre of the line band and 28 px off it:

| Placement | `renderingMode` | Centre (RGB) | 28 px off the line |
|---|---|---|---|
| `beforeId: "line"` (above fill, below line) | `2d` | green | blue |
| `beforeId: "line"` | `3d` | green | blue |
| top of the stack | `2d` | blue | blue |
| top of the stack | `3d` | blue | blue |
| `beforeId: "fill"` (below fill) | `2d` | green | red |

Identical in 4.7.1, 5.24.0 and 6.16.0. A custom layer sits exactly where `beforeId` puts it among ordinary style layers, in both modes. I did not measure depth interaction with terrain or fill-extrusion.

## 5. Repaint cost: on-demand vs self-driven

| | 4.7.1 | 5.24.0 | 6.16.0 |
|---|---|---|---|
| Renders in 2 s with no repaint source | 0 | 0 | 0 |
| 30 `triggerRepaint()` calls, 50 ms apart | 30 renders | 30 | 30 |
| Mean time in `render()` per on-demand frame | 0.023 ms | 0.060 ms | 0.080 ms |
| Self-driven loop (`triggerRepaint` inside `render`), 3 s | 180 renders = 60.0 fps | 180 = 60.0 fps | 180 = 60.0 fps |
| Mean time in `render()` per looped frame | 0.018 ms | 0.034 ms | 0.048 ms |

An idle map renders nothing, one `triggerRepaint` buys exactly one frame, and the self-driven loop is capped at the display rate (60 fps). A looping layer costs a whole frame of MapLibre work every 16.7 ms for as long as it loops, even when nothing changed, which is why the repaint model below is on-demand.

## 6. Context lost and restored

I forced loss with `WEBGL_lose_context.loseContext()`, waited 0.5 s, called `restoreContext()`, waited 2.5 s, then called `triggerRepaint()` and waited 0.5 s.

| | 4.7.1 | 5.24.0 | 6.16.0 |
|---|---|---|---|
| Hook / event order during the cycle | `webglcontextlost`, `webglcontextrestored` | `onRemove`, `webglcontextlost`, `webglcontextrestored` | `onRemove`, `webglcontextlost`, `webglcontextrestored` |
| `onAdd` called again after restore | no | no | no |
| `render` calls while lost | 0 | 0 | 0 |
| `render` calls after restore | 2 | 0 | 0 |
| Same `gl` object after restore | yes | yes | yes |
| Layer's program valid after restore | no | no | no |
| Layer's vertex buffer valid after restore | no | no | no |
| Layer's VAO valid after restore | no | no | no |

The list of GL objects the layer had to recreate itself: **the program, the vertex buffer and the vertex array object**, i.e. everything it had created. The `gl` object is the same, so the layer's handle to the context stays good but every resource handle from before the loss is dead. In 4.7.1 `render` kept being called on the dead handles, so the layer must detect loss itself (`gl.isContextLost()` or the map's `webglcontextrestored` event) and rebuild. In 5.24.0 and 6.16.0 the layer was removed and **not** re-added in the 3 s I watched, so the layer (or the add-on controller) must re-add it on `webglcontextrestored`. I did not measure what MapLibre's own sources and textures rebuild.

## Decision

1. **Integration surface:** `CustomLayerInterface` (`type: "custom"`, `renderingMode: "2d"`, `onAdd`, `onRemove`, `prerender`, `render`) on the `WebGL2RenderingContext` the layer is handed. The context type is as observed in section 1.
2. **Matrix convention:** input vertices in Mercator coordinates (x, y in [0, 1], y south, z 0), multiplied by the matrix MapLibre supplies: the argument itself in 4.x, `args.defaultProjectionData.mainMatrix` in 5.x and 6.x. One small adapter picks the matrix by argument shape. Verified to 0.00 px at pixel ratio 1 and within 0.71 px (measurement resolution) at pixel ratio 2.
3. **Placement:** use `beforeId` to sit among style layers; `renderingMode: "2d"` unless terrain interaction is needed later.
4. **Repaint model: on-demand.** Call `map.triggerRepaint()` only while there is pending work (newly arrived buffers, a refinement in flight, an animation). Per-frame cost measured: 0.02 to 0.08 ms in `render()` for the trivial draw across the three versions (software GL, so this is submit cost only). No always-on loop.
5. **Context loss:** the layer owns recreation of its programs, buffers and VAOs and re-adds itself on `webglcontextrestored`; it must not assume `onAdd` is called again. The supported MapLibre line is 4.7.1 up to 6.16.0, with the three exact versions above as the pinned test matrix.

Not covered here and left to later issues: projections other than Mercator (`M4.2`), the production layer and its GL-state hygiene (`M5.2`, `M5.7`), Firefox and WebKit behaviour of the custom layer (the container's Firefox had no WebGL2, see spike 06).
