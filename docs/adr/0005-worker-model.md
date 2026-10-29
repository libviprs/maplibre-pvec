# ADR 0005: Worker model

- Status: Accepted
- Date: 2026-10-29
- Evidence: `docs/spikes/07-workers-webgpu.md`

## Context

Decoding and tessellation run off the main thread. `SharedArrayBuffer` needs cross-origin isolation, which many hosts cannot provide, so the baseline has to work without it.

## Decision

1. A pool of Web Workers with **transferable `ArrayBuffer`s** as the default transport. `SharedArrayBuffer` is never required and no code path depends on `crossOriginIsolated`.
2. Initial pool size is the measured knee, **8 workers**, capped at `hardwareConcurrency`. Provisional: tuning is `M8.6`, and the stand-in workload was cheaper than real tessellation.
3. The queue is priority-aware: interaction work overtakes refinement.
4. Main-thread blocking from the pipeline stays under **1 ms per frame**.

Evidence (Chromium 130, 28 hardware threads, stand-in workload):

- Knee at 8 workers: 98,360 thousand segments/s without COOP/COEP, reaching 90% of the best of 106,194.
- The full fixture set completed with `crossOriginIsolated === false` (and `SharedArrayBuffer` undefined).
- Shared memory gained +6.1% at 8 workers (106,335 against 100,250), inside the noise; transfer is the default regardless.
- Transfer was 2.2 times faster than copy at one worker (29,197 against 13,400 thousand segments/s). At 8 workers the largest frame gap was 16.1 ms with transfer against 18.6 ms with copy.
- An interactive job queued behind 300 large jobs on 2 workers waited 655 ms in a FIFO queue and 2.1 ms in a priority queue.

## Consequences

- Deployments need no COOP/COEP. If a host provides them, a shared-memory path may be added later as an optimisation, not as a requirement.
- The pool needs a cost-aware, priority-aware scheduler (`M6.4`); a plain FIFO is rejected by the 655 ms figure.
- The knee has to be re-measured with the real WASM evaluator in the workers.
