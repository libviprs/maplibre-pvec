# ADR 0004: Buffer model

- Status: Accepted
- Date: 2026-10-29
- Evidence: `docs/spikes/03-wasm-evaluator.md`, `docs/spikes/07-workers-webgpu.md`

## Context

The add-on exchanges geometry between WASM, workers and the GPU. The question is the call shape and whether buffers are copied, transferred or shared. The real `pvec` evaluator as WASM does not exist yet, so only the call boundary and the transport were measured; the evaluator cost is deferred (`docs/deferred.md`).

## Decision

1. The evaluator is called with **one packed input buffer and returns one packed output buffer** per batch. There is no per-point or per-entity call.
2. ISO curve mathematics is evaluated only by the shared `pvec` Rust evaluator compiled to WASM. No curve arithmetic is written in TypeScript.
3. Buffers move between threads as **transferable `ArrayBuffer`s**. Shared memory is not part of the buffer model.

Evidence:

- A scalar call across the JS to WASM boundary cost 2.66 ns. Packed batches cost 1.12 ns per point and are flat from 1e2 to 1e5 points per call, against 2.14 to 2.56 ns per point for per-call dispatch (2.2 times at 1e2).
- 200 repetitions of a 1e5-point packed call (2e7 evaluations) grew the JS heap by 6,276 bytes: no per-entity JS object on the packed path.
- Transfer cost 0.00 to 0.05 ms per MiB per direction (0.3 ms on the main thread at 64 MiB); a structured-clone copy cost 0.19 to 1.65 ms per MiB (7.6 ms on the main thread at 64 MiB).

## Consequences

- The packed field layout is `P7.3`'s to define; this ADR only requires the one-buffer-in, one-buffer-out shape and re-checking the zero-allocation property against the real interface.
- Batch size follows the scheduler's chunk or block size, not call overhead, which is negligible above about 1e2 points. The batch size is a phase 8 tuning value (`M8.6`) and is provisional.
- Whether the WASM evaluator meets the frame budgets is still open until the real artifact exists.
