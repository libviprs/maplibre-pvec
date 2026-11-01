# Georeferencing

PVec stores drawing-local coordinates in the source unit. Map coordinates come from outside: a `GeoReference` is a constructor input and a setter argument (`GeoReferenceState.set`, wired to `setGeoReference` on the layer later). Nothing reads it out of a `.pvec` container and nothing writes it back. A test scans `src/transform` to keep it that way.

## Composition order

```text
source (unit) -> metres -> calibration -> CRS native -> lng/lat -> mercator -> camera -> device px
```

`createGeoTransform(geoRef)` validates the reference and returns `forward(x, y) -> [lng, lat]` and `inverse(lng, lat) -> [x, y]`.

## Changing it after the drawing is up

`layer.update({ georeference })` rebuilds the stroke tessellation and the corner positions of every raster quad (hi and lo split, in f64 first), through the same upload budget, and nothing else: textures, bitmaps and decodes in flight stay valid, because a decode does not depend on the transform, and no range is requested. The level of each raster is chosen again from the new scale. A transform epoch guards the rebuild, so positions made for the old georeference are never drawn after the new one is set. 1,000 updates in a row issue zero tile requests and zero range requests, and the scan edge still lands on the strokes (`106-raster-compose.spec.ts`).

## Rasters

There is one affine per raster, carried in the file (`pixel_to_source`, pixel to source space). The georeference above is the second half of the same chain: a raster corner goes pixel to source to world in f64 and then through the same hi and lo split as a stroke vertex, so a rotated, sheared or flipped placement costs nothing extra and the image lands on the linework. A raster cannot have a `projective` calibration of its own in v1. See [rasters](raster.md).

## Units

| unit | metres per unit |
|---|---|
| `mm` | 0.001 |
| `cm` | 0.01 |
| `m` | 1 |
| `in` | 0.0254 (exact) |
| `ft` | 0.3048 (exact) |

Anything else goes through `{ unitsPerMetre }`, which must be finite and above zero (`InvalidUnitError` otherwise). The tests assert these against hand-computed constants, not against the implementation.

## Affine calibration

Six coefficients in SVG matrix order `[a, b, c, d, e, f]`:

```text
x' = a*x + c*y + e
y' = b*x + d*y + f
```

Input is metres in the drawing frame, output is native CRS units (degrees for `Epsg4326Adapter`). `a..d` carry rotation, anisotropic scale and shear, `e, f` the translation. The scale from metres to degrees is part of the calibration, I do not hide it in the unit.

Worked example, plan anchored at 47.4 N, 8.5 E, rotated 30 degrees, `kLat = 1/110574`, `kLng = 1/(111320 cos 47.4)`:

```text
[kLng cos30, kLat sin30, -kLng sin30, kLat cos30, 8.5, 47.4]
```

A zero or non-finite determinant, any non-finite coefficient, or a non-finite inverse is rejected with `DegenerateCalibrationError` / `NonFiniteCalibrationError`. I do not normalise it quietly, and I define no conditioning tolerance here: those come from the numeric policy in `libviprs/pvec#1` (P1.2).

## Projective calibration

`kind: 'projective'` takes a row-major 3x3 homography. It is the opt-in fallback for rubber-sheeted or scanned plans, it is inert unless supplied, and it sits outside the Mercator conformance gate. The inverse viewport query inflates it from the local linearisation at the viewport centre only.

## CRS adapters

`CrsAdapter { id, forward, inverse }` is injected, so no projection library is a hard dependency. v1 ships `Epsg4326Adapter` (identity on degrees).

## Round-trip residual

`roundTripResidual` reports `max |inverse(forward(p)) - p|` and the same divided by `max(|x|, |y|, 1)`. Measured over 1e6 points (25 000 per unit and magnitude, seeded), magnitudes 1e0 to 1e7 source units, calibration anchored at 0,0 with 30 degree rotation and 1.1 anisotropy. The limit is 1e-9 times the magnitude:

| unit | worst relative residual over 1e0..1e7 |
|---|---|
| mm | 5.9e-16 |
| cm | 5.1e-16 |
| m | 4.9e-16 |
| in | 6.0e-16 |
| ft | 5.7e-16 |

Anchored at a real location (47.4 N, 8.5 E) there is a floor I cannot remove: the stored degrees have one `f64` ulp of about 7e-15 degrees, which is roughly 8e-10 m. That is why a 1 mm coordinate cannot hit 1e-9 relative there. The measured absolute residual stays at or under that floor:

| unit | abs residual at 1e0 | at 1e7 | gate (8 ulp floor, or 1e-9 x magnitude) |
|---|---|---|---|
| mm | 3.6e-7 | 3.7e-7 | 1.0e-5 |
| cm | 3.6e-8 | 4.0e-8 | 1.0e-6 |
| m | 3.6e-10 | 5.7e-9 | 1.0e-8 |
| in | 1.4e-8 | 1.8e-8 | 4.0e-7 |
| ft | 1.2e-9 | 8.3e-9 | 3.3e-8 |

So the issue's "1e-9 times magnitude" holds exactly when the output is not dominated by a large anchor offset, and otherwise the residual is bounded by the `f64` resolution of lng/lat. I did not relax anything, I just stated where the limit comes from.

Deriving calibration from DWG or PDF metadata is ingestion work (`libviprs/libviprs#1039`).
