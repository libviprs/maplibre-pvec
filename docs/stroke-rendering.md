# Stroke rendering

Decision: [ADR 0006](adr/0006-stroke-renderer.md).

The v1 renderer draws **instanced quads with a signed-distance (capsule) fragment shader**: one instance per segment, round joins and caps, analytic antialiasing and a dash phase carried per segment. `gl.lineWidth` is not used, because its range is implementation-defined (Chromium reported [1, 1]). The default style is monochrome.

Segments use the 40-byte record in [buffer model](buffer-model.md), with coordinates split into high and low parts relative to a block origin ([precision](precision.md)). A CPU-triangulated mesh from the same buffer is the documented fallback.

Measured against a 16 x 16 supersampled reference at 8 px width, the SDF fragment had a maximum coverage error of 0.22 near joins and caps, and a dash phase error of 0.023 px across a chunk boundary in Chromium. All frame times in the spike were taken on software GL, so they are relative costs only.

Known gaps: the outer edge of round joins, caps and the miter and bevel wedges is not antialiased in the shader (the CPU mesh is). Hatch and text are optional entries and are not part of the v1 stroke path. Details are in [deferred work](deferred.md), issue 50.
