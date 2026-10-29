# Spike 05: complete Tier 0 rendering with bounded-error previews

Spike for M1.5. **Not run. Deferred.**

The spike needs a Tier 0 complete-coverage stream from `pvec` (`P1.7`, `P5.4`) that carries a declared preview error for each deferred entity, the spatial directory that reports entity ids for a viewport (`P5.1`), the evaluator for the `f64` reference curves (`M1.3`, `P7.2`), and fixtures with a spline-heavy member via `O2.9` (`libviprs/pvec-gold-fixtures#1`). None of these exist yet, and the coverage audit and the preview error accounting are meaningless against invented data: a harness that wrote its own previews would be checking its own arithmetic.

What was done instead:

- The bootstrap cost to reach a complete viewport of Tier 0 bytes is measured on a provisional container in `docs/spikes/02-range-bootstrap.md` (requests, bytes and milliseconds per viewport preset).
- The stroke pipeline the previews would be drawn with is measured in `docs/spikes/06-stroke.md`.

What stays open, with the unblocking condition for each, is in `docs/deferred.md` under the issue #2 section. The preview representation is therefore **not** decided by phase 1; ADRs 0001 to 0008 do not depend on it, and `M5.1`, `M5.3` and `M2.6` should not start from an assumption about it.
