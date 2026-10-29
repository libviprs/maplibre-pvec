# ADR 0001: MapLibre integration surface

- Status: Accepted
- Date: 2026-10-29
- Evidence: `docs/spikes/01-maplibre-surface.md`

## Context

The add-on draws inside MapLibre GL JS. I needed to know which part of MapLibre it may depend on, at which versions, with which matrix convention and with what repaint behaviour, before any production layer exists.

## Decision

1. The integration surface is `CustomLayerInterface` (`type: "custom"`, `renderingMode: "2d"`, `onAdd`, `onRemove`, `prerender`, `render`), added with `beforeId` to sit among ordinary style layers.
2. The layer is handed a `WebGL2RenderingContext`. I observed this in 4.7.1, 5.24.0 and 6.16.0 (`gl instanceof WebGL2RenderingContext` was true, and it was the same object as `canvas.getContext("webgl2")`).
3. Matrix convention: vertices in Mercator coordinates (x, y in [0, 1], y south, z 0) times the matrix MapLibre supplies: the argument in 4.x, `args.defaultProjectionData.mainMatrix` in 5.x and 6.x. One small adapter picks by argument shape. Measured quad-to-lon/lat error at zoom 14: 0.00 device px at pixel ratio 1, 0.71 px at pixel ratio 2 (the resolution of the measurement), so inside 1 px.
4. Repaint is on-demand: `map.triggerRepaint()` only while work is pending. An idle map rendered 0 frames in 2 s, 30 requests produced 30 frames, and a self-driven loop ran at 60 fps with 0.018 to 0.048 ms of JS per frame (software GL, submit cost only).
5. The pinned test matrix is MapLibre 4.7.1, 5.24.0 and 6.16.0.

## Consequences

- No private MapLibre API is used. The version differences are confined to the matrix adapter.
- The layer must not assume GL state: after `render`, blend and depth test were left enabled by MapLibre, so the layer sets what it needs and restores what it changes (`M5.7`).
- On context loss the layer recreates its own program, buffers and VAO (all three were invalid after restore in every version). 5.24.0 and 6.16.0 call `onRemove` and did not call `onAdd` again within 3 s, so the add-on re-adds the layer on `webglcontextrestored`. 4.7.1 never called `onRemove` and kept calling `render` on dead handles, so the layer checks for loss itself.
- Chromium was the only engine exercised, so the compatibility matrix across browsers is open (`M2.8`, `docs/deferred.md`).
- The 6.x line ships ESM only, which the package build and the test harness have to account for.
