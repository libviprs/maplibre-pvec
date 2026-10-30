# Spike 03: shared Rust/WASM evaluator

Spike for M1.3. Harness: `spikes/pvec-real/` for the real evaluator (`tools/spike-real.sh`), `spikes/wasm-evaluator/` for the earlier boundary-only run. Raw numbers: `spikes/pvec-real/results.json` and `spikes/wasm-evaluator/results.json`. The tables are regenerated into `docs/benchmark-report.md`.

## The real evaluator (#80)

This is the run the acceptance criteria asked for. The subject is `wasm/pvec_eval.wasm`, the `pvec-wasm` crate at `libviprs/pvec` `c7aed3d` (442,797 bytes, ABI version 1), loaded by the production `loadEvaluator` and driven through `src/wasm/packed.ts`. The input is real `.pvec` bytes from pvec's own writer: the 22 corpus artifacts, and the generated entries `architectural-1e5`, `architectural-1e6`, `mep-1e5`, `spline-heavy-1e5` and `pathological-1e3` (their digests match pvec's corpus lock). Chromium 130, x86_64 Linux container on the shared docker host.

**Read every time with this caveat:** the host was loaded while this ran (a load average of 18 to 25), and it is software only. The nanoseconds are upper bounds, one engine, one machine. The shape is the result.

| Item | Result |
|---|---|
| Compile and instantiate | 24.6 ms and 0.2 ms for 442,797 bytes |
| One evaluation of a line or polyline (batch of 1, four views, release) | 1.3 to 2.1 microseconds |
| One evaluation of a curved fixture at a drawing-sized budget | 50 microseconds (`arc-seam-001`, 33 vertices) to 287 microseconds (`closed-periodic-001`, 177 vertices) |
| Repeated-knot NURBS (`repeated-knot-c0-001`) | 179.5 microseconds for 111 vertices, 1.66 microseconds per vertex at 1e5 vertices |
| Amortised, curved fixtures, 1e2 to 1e5 vertices from one curve | 1.51 to 1.84 microseconds per vertex, flat across four decades: `circle-001` 1.51 to 1.55, `nurbs-d3-001` 1.65 to 1.71, `bspline-d5-001` 1.77 to 1.84 |
| Whole drawing, 1e5 entities, packed | `architectural-1e5` 149 ms (1.49 microseconds per entity, 517 ns per vertex), `mep-1e5` 272 ms, `spline-heavy-1e5` 1,198 ms (12 microseconds per entity), `architectural-1e6` 959 ms |
| Pathological entry (917 entities, splines of 10,000 control points) | 52.8 ms, 0 entities failed |
| Float32 against float64 output | the same time (within 1 percent) |
| JS allocation on the packed path | 50 whole-drawing calls of 1e5 entities moved the JS heap by less than 45 kB either way (under 0.01 byte per entity); four typed arrays per call, whatever the entity count |
| Linear memory | no growth across 6,000 open, query, tessellate and release cycles. The high-water mark after the 17.8 MB `architectural-1e6` file is 8,521 pages (533 MB), and WASM memory cannot shrink |
| Open (copy in and parse) | 65 ms for 1.8 MB, 660 ms for 17.8 MB, 328 ms for 12.3 MB |

What this changes:

1. **Call shape stands, and the boundary stops mattering.** A call across the boundary was 2.7 ns, a vertex is 1,500 ns or more. The reason to batch is the packed layout, as the earlier run said.
2. **The cost model has a number.** About 1.5 to 1.8 microseconds per vertex for a single curve on this host means one 8 ms frame share buys roughly 4,500 to 5,300 vertices if tessellation ran on the main thread. It does not belong there: the refinement queue has to stay on workers with the budgets it already has. I did not change `nsPerCostUnit` or any default; the retune waits for numbers from a quiet machine (issue 82).
3. **Whole-drawing tessellation is not a frame-time operation.** 150 ms for 1e5 architectural entities is a worker job split into slices, not something to do on a camera move.
4. **A handle bug.** After a slot has been reused 32,768 times, `pvec-wasm` returns a handle with the sign bit set, which reads as an error code (`libviprs/pvec#203`, draft PR with red tests `#204`). My first run died on it. `src/wasm/packed.ts` returns such a handle as the unsigned number it is.
5. **A polyline with a budget below the coordinate resolution subdivides.** `large-coords-001` (coordinates near 1e6) returns 4 vertices at any sensible budget and 126,708 when the budget is pushed below what a double can resolve there. I note it as an observation, nothing depends on it.

The preview error accounting and coverage audit that belong to spike 05 ran in the same harness, see `docs/spikes/05-tier0-coverage.md`.

Not measured, and why: Firefox and WebKit (issue 81), hardware (issue 82), pvec's native `O1.5` probe suite (the `pathological-1e3` entry is the stand-in), and the Tier 0 stream, which `pvec-wasm` does not export (`libviprs/pvec#201`).

## The call boundary alone (earlier run)

### Scope

The acceptance criteria ask for numbers on the `pvec` evaluator compiled to WASM, through `P7.3`'s packed output and `P7.2`'s evaluation and tessellation API. Neither exists yet: `libviprs/pvec` has no WASM build of the evaluator and no packed interface (its only WASM crate is a container spike). So I could not measure curve evaluation, bounds or tessellation at the time. The real evaluator section above has them.

What I could measure for real is the JS to WASM **call boundary**, which is the thing the call-shape decision turns on. The harness hand-assembles a tiny WASM module that exports `add(f64, f64) -> f64` and `batch(ptr, n) -> f64` (sums `sqrt` of `n` packed `f64` values read from linear memory). Nothing in it is curve arithmetic, and no curve arithmetic exists in TypeScript in this spike, so there is nothing to remove before the spike closes.

| Item | Value |
|---|---|
| Engine | Chromium 130.0.6723.31, headless, x64 Linux container (one engine only) |
| Run | 5,000,000 calls after a 100,000 call warm-up; batches repeated to about 2e7 points per size |

### Boundary numbers

| Measurement | Result |
|---|---|
| One scalar call across the boundary (`add`) | **2.66 ns/call** (a plain JS loop doing the same add: 0.94 ns) |

| Batch size n | Packed call, ns per point | Per-call dispatch, ns per point | Packed advantage |
|---|---|---|---|
| 1e2 | 1.135 | 2.54 | 2.2x |
| 1e3 | 1.115 | 2.56 | 2.3x |
| 1e4 | 1.120 | 2.36 | 2.1x |
| 1e5 | 1.120 | 2.14 | 1.9x |

The "per-call dispatch" column loads each value from the packed array in JS and calls `add` once per point, so it includes the load; the packed column is one `batch` call per `n` points.

- **Crossover:** packed batching already wins at the smallest batch I tried (n = 1e2, 2.2x), so the measured crossover is **at or below 100 points**; I did not look for a smaller one. The amortised packed cost is flat from 1e2 to 1e5 (1.12 ns/point), so the boundary itself stops mattering after about 1e2 points per call.
- **Caveat that matters:** the boundary is about 2.7 ns per call, so for any real curve evaluation (tens to thousands of ns per point) the boundary is noise either way. The reason to batch is the data layout (one packed input and one packed output), not call overhead.
- **Heap:** 200 repetitions of a 1e5-point packed call (2e7 evaluations in total) grew the JS heap by 6,276 bytes (about 0.0003 bytes per evaluation, noise from the harness), and 1,939,178 bytes after a forced GC against 1,939,610 before. No per-entity JS object is allocated on the packed path. This holds for this trivial module, and the production interface must be re-checked (`P7.3`).

### Not measured then

- Real evaluator cost, the repeated-knot NURBS and the other named fixtures (needs `P7.2`, `P7.3`, `O1.5` probes).
- Transferable `ArrayBuffer` against structured-clone copy in ms/MiB at three sizes: measured in spike 07 (`docs/spikes/07-workers-webgpu.md`), where the worker transport lives.
- Other engines (Firefox, WebKit) and their versions for this benchmark.

## Decision (updated)

1. **Call shape: packed batch.** The add-on calls the evaluator with one packed input buffer and receives one packed output buffer, never one call per point or per entity. Batch size is chosen by the scheduler (a chunk or block of entities), not by call overhead, which is flat above about 1e2 points.
2. **Evaluated only in Rust/WASM.** ISO curve mathematics is evaluated only by the shared `pvec` evaluator compiled to WASM. No curve arithmetic was written in TypeScript in this spike, and the add-on may not add any.
3. **The layout is `P7.3`'s, and it held.** Four typed arrays and an integer handle per batch, as `libviprs/pvec` `docs/WASM_ABI.md` defines, measured above with no per-entity JS allocation.
4. **Tessellation runs on workers, in slices.** The measured cost per vertex rules out main-thread tessellation of anything beyond a handful of curves per frame. The budgets are not retuned here; the hardware and quiet-machine numbers are issue 82's.
