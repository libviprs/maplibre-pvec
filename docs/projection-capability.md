# Projection capability

Projection support is capability-based. Mercator is the only v1 conformance target.

| projection | state | attach without opt-in |
|---|---|---|
| mercator | conformant | yes |
| globe | experimental | `UnprovenProjectionError` |
| anything else | unsupported | `UnprovenProjectionError` |

`gateProjection(id, { allowUnprovenProjection })` is the attach-time check. With the opt-in it returns `nonConformant: true`, which diagnostics and rendering snapshots carry, and `conformanceMayPass` then refuses a pass. Positional agreement is display fidelity (EPIC P's conformance class). Nothing here calls a projected result mathematically exact.

## Promotion criteria

A projection can be marked `conformant` only while every criterion's test exists and passes. `tests/unit/transform/projection.test.ts` checks that each id below is a test title.

| id | criterion | test title |
|---|---|---|
| PC1 | transform agreement: `project` and the ground inverse agree, mercator round-trips | `PC1 transform agreement` |
| PC2 | jacobian-based error inflation: `jacobianAt` matches a Richardson finite difference to 1e-6 relative (latitude +/-85, zoom 0 to 22), and `maxErrorInflation` covers the measured sag of a straight screen edge | `PC2 inflation bound` |
| PC3 | deep-zoom stability: centre stays on the centre pixel and the jacobian stays regular at zoom 18 to 22 | `PC3 deep-zoom stability` |

The Mercator adapter here is derived from MapLibre's camera model (field of view 0.6435011087932844, 512 px tiles). The comparison against MapLibre's own projection needs a real browser, see `docs/deferred.md`.

## Viewport query (what the scheduler gets)

`viewportToSourceBounds` samples 16 points per viewport edge, doubles until the sampled bounds stop growing by more than 0.5 percent, inverts through the CRS and calibration, then grows the result by `maxErrorInflation` (as lng/lat corner shifts) plus one chunk margin. The far plane is clamped to 1.5 screens of ground distance. Measured in `tests/unit/transform/inverse.test.ts`:

| check | result |
|---|---|
| containment, 10 000 random cameras, about 1e6 Monte-Carlo points | 0 escapes |
| same run with the inflation term removed (named mutation) | 376 escapes |
| cost per call | 0.04 ms median (limit 0.2) |
| `viewportToSourceRings` area over true preimage | median 1.00, p99 1.17 |
| `viewportToSourceBounds` AABB area over true preimage | median 1.81, p99 2.61 |

The AABB misses the 1.35 median target the issue asks for: an axis-aligned box around a viewport that bearing and plan rotation have turned cannot do better than the rectangle's own bounding box, so the median sits near 1.8 for random orientations. The ring (convex hull) meets 1.35 and 3.0 comfortably, so the scheduler should use rings where it can and the AABB for the coarse block test. I gate the ring numbers and record the AABB ones.
