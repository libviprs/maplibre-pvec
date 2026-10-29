# PVec semantic reuse

This package defines no curve mathematics and no numeric policy. Both come from `libviprs/pvec#1` (P1.2): the ISO 10303-42 style curve definitions, evaluation, domains, trims, derivatives, bounds and the mathematical tolerances. The browser calls the same Rust code compiled to WASM, through one packed buffer in and one packed buffer out ([ADR 0004](adr/0004-buffer-model.md)).

What lives here instead:

- A **display-fidelity budget** in CSS or device pixels (`ErrorPolicy.displayTolerancePx`, `DISPLAY_FIDELITY_TARGET_PX`). It decides when a tessellation is good enough to show. It is a rendering budget, not a statement about the curve.
- Scheduling, caching, transport and rendering of what the evaluator returns.

No TypeScript curve arithmetic ships. If the WASM module cannot be fetched or compiled, `loadEvaluator` rejects with `wasm_unavailable` and nothing falls back to a second implementation.

Capability names and the accepted version range are frozen in `release/v1-freeze.json` and mirrored in [compatibility](compatibility.md). Conformance classes are EPIC P's, evidence classes EPIC O's; this page cites them rather than restating them.

The real evaluator artifact does not exist yet, so the numbers that need it are deferred. See [deferred work](deferred.md), issues 2 and 58.
