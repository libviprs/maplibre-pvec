# Deferred work

Things that cannot be done for real in this repository today, each with the reason and what unblocks it.
Append a section per issue.

## #10 browser conformance suite

What landed: the pinned corpus registry and fail-closed loader (shared by Vitest and the in-page Playwright
suites), the evidence-class gating and claim table, the run summary, the guards (no converter image, no STEP
parsing, no tolerance literal, no external host), the hermetic range origin and the four-job runner with
declared-pending gates. What follows could not be done for real yet.

| Item | Why it waits | Unblocked by |
|---|---|---|
| Canonical `.pvec` path per fixture (`M2.1`) | pvec has not generated canonical containers from the fixture geometry. The registry records `canonicalPvec: PENDING` for all 30 fixtures instead of inventing a path. | `libviprs/pvec#1` P2.4 |
| Headless evaluator tests and the five-mutation table (`M2.3`) | They run the real WASM build of the shared evaluator, which does not exist as an artifact yet. | #2 (M1.3) and `libviprs/pvec#1` P7.2, P7.3 |
| Equivalence layer and its tolerance access point (`M2.4`) | The tolerances come from the PVec build's policy surface (P1.2). The guard already forbids local ones and exempts `tests/policy/access.ts` for when it lands. | `libviprs/pvec#1` P1.2, P2.6 |
| Transform and display pipeline suite (`M2.5`) | The georeference contract, projection adapter and screen-space error evaluator are not implemented. Registered as pending gate `pipeline`. | #42 (M4.1, M4.2, M4.4) |
| Tier 0 preview and refinement suite (`M2.6`) | There is no Tier 0 decoder or refinement scheduler to drive. Registered as pending gate `tier0`. | #50 (M5.1) and the refinement issues |
| Parser and range security suite (`M2.7`) | It needs the browser reader and the limits from `M3.1`/`M3.6`. Registered as pending gate `hostile-input`. | #18, `libviprs/pvec#1` P4.7, P4.8 |
| Real-world dual-oracle fixtures (`M2.2`) | The corpus has no `DUAL_ORACLE_EQUIVALENT` or `REAL_WORLD_DIFFERENTIAL` fixture yet (a second converter has not run). The registry, gating rule and claim table already handle both classes and are tested with reclassified fixtures. | `libviprs/pvec-gold-fixtures` second-oracle route |
| Snapshot baselines keyed by renderer string (`M2.8`) | There is nothing rendered to snapshot. The job exists and reports pending. | #50 |
| Origin as a separate container, x64 labelling on arm64 default | The origin is a loopback Node process started and stopped by Playwright inside the same throw-away container as the run, which is hermetic but not a second container. The gate ran on the x64 docker host only, so results here are labelled x64. | an arm64 run on mercury |
