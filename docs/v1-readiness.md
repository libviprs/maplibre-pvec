# v1 readiness

I have not tagged or published anything. The package is `private` at `0.0.0`, and `node tools/release-gate.mjs --tag-check` refuses to pass while any freeze condition is open. This page says which acceptance items are met and which are deferred, and where the reason is written down. The machine-readable versions are `release/v1-freeze.json` (what is frozen) and `release/v1-gate.json` (one entry per freeze condition, rebuilt from the tree by `tools/release-gate.mjs`; Actions is off, so the local gate produces it).

## Freeze conditions

| condition | state | measured | where |
|---|---|---|---|
| conformance suite green on every supported browser row | met | 3 of 3 rows supported (chromium 111 to 130, firefox 131, webkit 18.0), each across MapLibre 4.7.1, 5.24.0 and 6.16.0, with the raster grid spec (`tests/e2e/grid/107-raster-grid.spec.ts`) among the grid runs; evidence in release/browser-grid.json | `release/v1-gate.json`, [deferred work](deferred.md), issue 107 |
| all gates green on the frozen corpus after tuning | met | 28 of 30 corpus cases have `.pvec` bytes from pvec's generator, and the other two, `near-singular-001` and `translation-001`, are refused by design (`libviprs/pvec` ADR 0017); the baseline run's variance is within its limit. The add-on's own replay of the viewport scripts on those bytes is still issue 34 | [deferred work](deferred.md), issue 34 and issue 40 |
| no QUARANTINED fixture in the pass set | met | 0 quarantined among the 28 cases with bytes | `release/v1-gate.json` |
| WASM-blocked and non-isolated paths behave as documented | met | through the real layer: one `wasm_unavailable` error event, zero range requests, MapLibre's pixels unchanged (0 of 102400 differ), also from the installed tarball. Evidence in `release/evidence/83-wired-layer.json` | [deferred work](deferred.md), issue 83 |
| lifecycle leak and context-loss tests green | met | forced `WEBGL_lose_context` then restore on a WebGL2 canvas through the layer: zero new range requests, snapshot identical (0 differing pixels), strokes back; with MapLibre's own layers the pixels outside the strokes match (0 differing) and the guard saw no leaked state in any frame. Measured on SwiftShader, with a stand-in evaluator and cursor | [deferred work](deferred.md), issue 83 |
| examples pass with outbound network denied | deferred | 2 of 6 examples written; `01-minimal` and `07-raster-underlay` pass against their own 127.0.0.1 servers with every other origin refused. 02 to 06 are #84 and PR #85, still open | [deferred work](deferred.md), issue 31 and #84 |
| API report identical to the committed baseline | met | report regenerates with no diff and matches the frozen hash, the raster names (`raster` option, `rasterskipped`, `RasterInfo`, `rasters()`) among the 7 declarations that mention rasters | `etc/maplibre-pvec.api.md` |
| render CPU with rasters (`raster_render_budget`, added by #110; the list of required conditions above is unchanged) | met | on frames that upload no tile at most 1.5 ms p95 on every real renderer (Apple M5 Chromium 0.2 ms, Apple GPU WebKit 0.46 ms as the mean because its timer is clamped to 1 ms, Intel ADL GT2 Chromium 1.1 ms), no frame that uploads a tile longer than 16.7 ms (largest 10.9 ms) | `release/v1-gate.json`, `bench/baselines/renderer-baselines.json`, ADR 0009 |

## Acceptance of the freeze task

| item | state |
|---|---|
| The release step refuses to tag unless every condition is present and met; removing an entry blocks it | met (`tools/release-gate.mjs --tag-check`, tested with a synthetic green gate and a gate with an entry removed) |
| The frozen API report is committed and a later change is caught | met locally: the surface test and `release/v1-freeze.json` fail on any difference, and `classifyApiChange` states whether the change needs a minor or a major bump. Actions is off, so the local gate is what runs it |
| `compatibility.json` has exactly one conformance-baseline projection, `mercator`; WebGPU only experimental; `SharedArrayBuffer` only optional | met (tested) |
| Frozen budgets equal the tuned values, checked by equality between `defaults.ts` and `release/v1-freeze.json` | met (tested). Checked against real hardware in #82 (Apple M5 Metal, Apple GPU WebKit, Intel ADL GT2), no value needed to change, see [deferred work](deferred.md). The raster constants (`RASTER_DEFAULTS`) and the render budget with rasters (1.5 ms p95 on frames that upload no tile, `rasterProvenance.renderBudget`) are frozen the same way, measured in #108 on the same three renderers |
| Release notes describe benchmark results as display fidelity | met in `CHANGELOG.md`; the docs check also rejects calling a display-fidelity result exact |
| `1.0.0` bump and the tag | deferred on purpose: the gate is not green and publishing is out of scope |

## Acceptance of the documentation task

| item | state |
|---|---|
| Every page exists and is reachable from `docs/README.md`; an index test fails on a missing or orphaned page | met |
| `benchmark-report.md` regenerates from `bench/results` with no diff, each number with a corpus case, baseline and threshold | met for the one committed result; the add-on's own runs are deferred (issue 34) |
| `slo.md` regenerates the same way | met for the baseline run; the add-on's mark is not claimed |
| `precision.md` numeric envelope generated from `bench/out/precision-stress.json` and M8.5 | partly: the table is generated by `tests/unit/transform/stress.test.ts` and compared against the page, not from a `bench/out` file; M8.5 results do not exist (issue 34) |
| API reference regenerates with no diff; a documented symbol not exported fails | met |
| Zero dead internal links; code samples use no non-localhost origin | met |
| Samples resolve against the M7.8 fixture server | deferred: only `01-minimal` exists (issue 31) |
| A display-fidelity result is never called exact; no mathematical tolerance stated | met (scanned over `docs/`, spike reports and the deferred list excluded) |
| One page per subject | met (a subject table in `tools/docs.mjs` is tested) |
| Docs build in CI with a link check | met locally (`npm test`); CI is disabled |

## What would turn the deferred rows green

Examples 02 to 06. The evaluator is the published `libviprs/pvec` release `wasm-v1-dcef7f6`, the corpus bytes are in (28 of 30, the other two refused by design) and the default cursor reads the evaluator's Tier 0 stream. Each is written up in [deferred work](deferred.md).

Descoped from #82, not claimed: an NVIDIA run (no driver or container runtime on MARS) and an arm64 Linux run with a real GPU (Docker Desktop passes none through). What was measured is the Apple M5 (Chromium Metal), Apple GPU (WebKit), Intel ADL GT2 (Chromium) and, as software GL only and not GPU numbers, arm64 Linux in a container. A driver and container toolkit on MARS, or an arm64 Linux host with a GPU, would unblock them.
