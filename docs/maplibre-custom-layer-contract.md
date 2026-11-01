# MapLibre custom layer contract

Decision: [ADR 0001](adr/0001-maplibre-integration-surface.md), evidence in the first spike report.

- The integration surface is `CustomLayerInterface` with `type: "custom"` and `renderingMode: "2d"`. No private MapLibre API is used.
- `onAdd` receives a `WebGL2RenderingContext` in 4.7.1, 5.24.0 and 6.16.0.
- Vertices are Mercator coordinates (x and y in [0, 1], y south) multiplied by the matrix MapLibre passes: the argument in 4.x, `defaultProjectionData.mainMatrix` in 5.x and 6.x. One adapter chooses by shape. At zoom 14 the measured landing error against `map.project()` was 0.00 device px at pixel ratio 1 and 0.71 px (the measurement resolution) at pixel ratio 2.
- Repaint is on demand: `map.triggerRepaint()` only while work is pending.
- The layer does not assume GL state. It sets what it needs and restores what it changes, and it recreates its program, buffers and VAO after context loss.

## Layer API

`createPVecLayer(options)` validates options and makes no request. `onAdd` starts the bootstrap, `whenReady()` resolves once the first bootstrap is over (it never rejects), `update(partial)` changes georeference, limits, cache, error policy or style without refetching canonical bytes, and `on`, `off` and `once` subscribe to events. The full signatures are in the [API reference](api/reference.md) and the exported names in [public surface](api/public-surface.md).

## Draw order

The PVec layer is one style layer. Inside it the order is band 0 rasters, the strokes, band 1 rasters. Against the rest of the style, `beforeId` of `map.addLayer(layer, beforeId)` is the only ordering knob: a MapLibre layer placed after the PVec layer draws over band 1 (labels in a `symbol` layer above stay readable), one placed before it is covered by the opaque part of band 0 and shows through the scan's baked alpha. The layer draws with the stencil test off, writes no stencil, and blends `ONE, ONE_MINUS_SRC_ALPHA` over whatever is underneath (the bitmaps are decoded premultiplied, `opacity` multiplies into the fragment). `tests/e2e/rendering/106-raster-compose.spec.ts` checks each of these on 4.7.1, 5.24.0 and 6.16.0.

## Not yet true

`assertMapLibreVersion` and `assertWebGL2` exist and are tested, but `onAdd` does not call them yet, so the `unsupported_maplibre_version` and `webgl2_required` refusals are not reachable from a real attach. See [deferred work](deferred.md).
