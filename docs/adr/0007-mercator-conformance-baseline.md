# ADR 0007: Mercator conformance baseline

- Status: Accepted
- Date: 2026-10-29
- Evidence: `docs/spikes/01-maplibre-surface.md`, `docs/spikes/04-precision.md`

## Context

Mercator is the only projection whose custom-layer transform and error behaviour I measured. MapLibre 5.x and 6.x also expose globe and other projection data to custom layers.

## Decision

Mercator is the v1 conformance baseline and the only advertised conformance target. Another projection is capability-gated and is advertised only after it proves an equivalent transform and error behaviour against the same checks.

Evidence for the baseline:

- The Mercator matrix convention was demonstrated, not assumed: a quad drawn with `MercatorCoordinate` vertices and the supplied matrix landed 0.00 device px from `map.project()` at pixel ratio 1 and within 0.71 px (measurement resolution) at pixel ratio 2, in 4.7.1, 5.24.0 and 6.16.0 at zoom 14.
- The precision budget of ADR 0002 was established on a planar camera path (up to 16,384 px per unit); it says nothing about a spherical transform.

## Consequences

- The matrix adapter reads the Mercator matrix only. 5.x and 6.x also provide `fallbackMatrix` and `projectionTransition`, which I did not exercise, so globe rendering is unsupported until `M4.2` proves it.
- Documentation and the compatibility matrix list Mercator as supported and everything else as unsupported, not as untested-but-probably-fine.
