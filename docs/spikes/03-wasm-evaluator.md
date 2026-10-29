# Spike 03: shared Rust/WASM evaluator, boundary cost

Spike for M1.3. Harness: `spikes/wasm-evaluator/` (`tools/spike.sh wasm-evaluator`). Raw numbers: `spikes/wasm-evaluator/results.json`.

## Scope actually measured

The acceptance criteria ask for numbers on the `pvec` evaluator compiled to WASM, through `P7.3`'s packed output and `P7.2`'s evaluation and tessellation API. Neither exists yet: `libviprs/pvec` has no WASM build of the evaluator and no packed interface (its only WASM crate is a container spike). So I could **not** measure curve evaluation, bounds or tessellation, a rational NURBS with repeated knots, or per-point cost of real geometry. Those are written up in `docs/deferred.md`.

What I could measure for real is the JS to WASM **call boundary**, which is the thing the call-shape decision turns on. The harness hand-assembles a tiny WASM module that exports `add(f64, f64) -> f64` and `batch(ptr, n) -> f64` (sums `sqrt` of `n` packed `f64` values read from linear memory). Nothing in it is curve arithmetic, and no curve arithmetic exists in TypeScript in this spike, so there is nothing to remove before the spike closes.

| Item | Value |
|---|---|
| Engine | Chromium 130.0.6723.31, headless, x64 Linux container (one engine only) |
| Run | 5,000,000 calls after a 100,000 call warm-up; batches repeated to about 2e7 points per size |

## Boundary numbers

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

## Not measured (deferred)

- Real evaluator cost, the repeated-knot NURBS and the other named fixtures (needs `P7.2`, `P7.3`, `O1.5` probes).
- Transferable `ArrayBuffer` against structured-clone copy in ms/MiB at three sizes: measured in spike 07 (`docs/spikes/07-workers-webgpu.md`), where the worker transport lives.
- Other engines (Firefox, WebKit) and their versions for this benchmark.

## Decision

1. **Call shape: packed batch.** The add-on calls the evaluator with one packed input buffer and receives one packed output buffer, never one call per point or per entity. Batch size is chosen by the scheduler (a chunk or block of entities), not by call overhead, which is flat above about 1e2 points.
2. **Evaluated only in Rust/WASM.** ISO curve mathematics is evaluated only by the shared `pvec` evaluator compiled to WASM. No curve arithmetic was written in TypeScript in this spike, and the add-on may not add any.
3. **Provisional:** the exact packed layout is `P7.3`'s to define. This decision constrains its shape (one packed buffer in, one out) and not its field layout.
4. The evaluator-cost numbers that would show whether the WASM path meets frame budgets are open and are tracked as deferred in `docs/deferred.md`.
