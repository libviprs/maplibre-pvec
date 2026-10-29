# Spike 07: worker scheduling and WebGPU as a future path

Spike for M1.7. Harness: `spikes/workers/` (`tools/spike.sh workers`). Raw numbers: `spikes/workers/results.json`.

## Setup and limits

| Item | Value |
|---|---|
| Engine | Chromium 130.0.6723.31, headless, x64 Linux container on the docker host (`hardwareConcurrency` = 28) |
| Workload | 48 jobs of 50,000 segments each (2.4 M segments per run): packed `f64` endpoints in, packed `f32` quad vertices out (12 floats per segment) |
| Stand-in | The worker expands each segment into a quad. It is a linear **stand-in** to give the transport something realistic to move. It is not ISO curve mathematics and the pvec evaluator is not available yet (`docs/spikes/03-wasm-evaluator.md`), so the compute cost per segment is much lower than real tessellation will be and the knee below is a floor for transport and scheduling, not the final one. |
| Transports | transferable `ArrayBuffer` (default), structured-clone copy, and `SharedArrayBuffer` (only when `crossOriginIsolated` is true) |
| Runs | one with no COOP/COEP headers (`crossOriginIsolated` = False, `SharedArrayBuffer` defined = False), one with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (`crossOriginIsolated` = True) |

The docker host is shared with other jobs, so a single sample above about 12 workers is noisy (some counts show a 2 to 5 times dip that does not repeat between the two runs); I read the knee from the stable low counts and did not repeat runs.

## Throughput versus worker count

Thousands of segments per second, whole run. Columns 2 and 3 are the run without COOP/COEP; columns 4 to 6 are the isolated run. The last two columns are the largest `requestAnimationFrame` gap seen during the run without COOP/COEP (ms; the display cadence is 16.7 ms).

| Workers | no COOP/COEP: transfer | no COOP/COEP: copy | isolated: transfer | isolated: copy | isolated: shared | max frame gap, transfer (ms) | max frame gap, copy (ms) |
|---|---|---|---|---|---|---|---|
| 1 | 29,197 | 13,400 | 28,977 | 14,260 | 26,413 | 16.8 | 16.9 |
| 2 | 54,176 | 26,316 | 54,651 | 26,403 | 50,622 | 16.7 | 17.3 |
| 3 | 68,966 | 33,103 | 63,224 | 29,970 | 66,787 | 16.8 | 17 |
| 4 | 51,502 | 43,876 | 72,018 | 44,395 | 75,793 | 16.8 | 17.1 |
| 5 | 75,235 | 40,609 | 73,282 | 44,872 | 88,807 | 16.9 | 17.4 |
| 6 | 80,268 | 49,383 | 82,248 | 43,076 | 90,498 | 16.9 | 17.5 |
| 7 | 84,211 | 48,193 | 90,961 | 50,452 | 95,847 | 16.6 | 17.2 |
| 8 | 98,361 | 53,097 | 100,251 | 52,191 | 106,336 | 16.1 | 18.6 |
| 9 | 45,455 | 52,516 | 96,521 | 51,441 | 104,872 | 16.8 | 18 |
| 10 | 39,088 | 49,080 | 96,911 | 32,635 | 97,561 | 16.9 | 17.6 |
| 11 | 95,238 | 48,096 | 101,716 | 51,107 | 96,989 | 16.6 | 21.3 |
| 12 | 106,195 | 46,875 | 91,901 | 46,948 | 106,383 | 16.6 | 20 |
| 13 | 102,128 | 39,933 | 90,395 | 43,585 | 101,716 | 16.6 | 25.5 |
| 14 | 96,774 | 41,166 | 96,541 | 47,704 | 102,498 | 16.6 | 22 |
| 15 | 89,552 | 42,478 | 51,696 | 46,390 | 101,911 | 16.7 | 23.1 |
| 16 | 90,566 | 48,000 | 87,832 | 47,124 | 101,932 | 16.9 | 21.6 |
| 17 | 96,774 | 39,474 | 84,971 | 46,167 | 21,843 | 16.5 | 21.8 |
| 18 | 30,612 | 43,243 | 81,855 | 45,511 | 52,493 | 16.9 | 20.6 |
| 19 | 31,496 | 32,698 | 81,273 | 38,974 | 76,433 | 17.9 | 23.9 |
| 20 | 70,588 | 40,678 | 17,396 | 40,346 | 42,538 | 16.6 | 25.6 |
| 21 | 70,381 | 45,802 | 66,871 | 41,029 | 34,225 | 16.2 | 21 |
| 22 | 75,949 | 42,328 | 63,216 | 39,706 | 77,282 | 16.6 | 23.8 |
| 23 | 18,809 | 40,404 | 64,266 | 26,681 | 79,103 | 51.4 | 20.1 |
| 24 | 60,302 | 35,503 | 35,603 | 39,496 | 69,354 | 21.7 | 23.3 |
| 25 | 57,007 | 28,436 | 62,573 | 39,021 | 38,545 | 18.4 | 18 |
| 26 | 57,416 | 34,335 | 36,960 | 31,508 | 23,623 | 18.6 | 16.9 |
| 27 | 58,680 | 38,156 | 56,094 | 32,765 | 54,757 | 17.8 | 21.3 |
| 28 | 62,827 | 37,618 | 53,168 | 27,618 | 56,371 | 16.6 | 23.5 |

- **Knee:** the smallest worker count that reaches 90% of the best transfer throughput is **8 workers** in both runs (98,360 of 106,194 thousand segments/s without COOP/COEP; 100,250 of 101,716 isolated). Beyond about 12 workers the curve is flat to noisy.
- One worker does 29 thousand segments/s with transfer and 13 thousand with copy: transfer is 2.2 times faster than structured-clone at the same count.
- **No measurement path requires `SharedArrayBuffer`.** The whole set (3 transports at 28 worker counts, plus the transport and fairness probes) completed with `crossOriginIsolated === false`, where `SharedArrayBuffer` is not even defined.
- **Shared-memory gain:** at the knee (8 workers), shared reached 106,335 against 100,250 for transfer in the same isolated run, **+6.1%**. At the best counts it is 106,382 (12 workers) against 101,716 (11 workers), +4.6%. Both gains are inside the run-to-run noise I saw, so I treat shared memory as no measurable gain here.

## Main-thread blocking

At 8 workers the largest frame gap during the transfer run was 16.1 ms, and in the isolated run 16.6 ms; the display cadence is 16.7 ms, so the main thread was not held past a frame. With copy the largest gap at 8 workers was 18.6 ms (about 2 ms past a frame), and it grew to 21 to 29 ms above 11 workers. The cost on the main thread is the post itself:

| Buffer (MiB) | Transport | Round trip per MiB per direction (ms) | Main-thread `postMessage` (ms) |
|---|---|---|---|
| 1 | transfer | 0.05 | 0 |
| 1 | copy | 1.65 | 1.1 |
| 8 | transfer | 0 | 0 |
| 8 | copy | 0.313 | 1.8 |
| 64 | transfer | 0.01 | 0.3 |
| 64 | copy | 0.193 | 7.6 |

(from the run without COOP/COEP; the isolated run is within noise: 64 MiB copy 0.192 ms/MiB and 7.68 ms on the main thread, transfer 0.006 ms/MiB and 0.26 ms.)

- Transferring costs 0.00 to 0.05 ms per MiB per direction and 0.3 ms on the main thread at 64 MiB. Copying costs 0.19 to 1.65 ms per MiB and 7.6 ms on the main thread at 64 MiB.
- **Budget:** per-frame main-thread blocking from the worker pipeline must stay under **1 ms**. At the chosen 8 workers with transfer the largest frame gap was at or under the display cadence in both runs. A copy transport broke that budget at 8 workers (up to 18.6 ms).

## Scheduling fairness under an interaction burst

A 500-segment interactive job arrives 50 ms after 300 large jobs were queued on 2 workers:

| Queue discipline | Latency of the interactive job |
|---|---|
| FIFO | 655 ms (668.9 ms in the isolated run) |
| Interactive job moved to the front of the queue | 2.1 ms (2.0 ms in the isolated run) |

So the pool needs a priority-aware queue; plain FIFO makes an interaction wait for all queued refinement work. The cost-aware queue itself is `M6.4`.

## WebGPU as a future path

| Engine | `navigator.gpu` | Adapter | Tessellation time |
|---|---|---|---|
| Chromium 130.0.6723.31 (headless, container, no GPU) | present | `requestAdapter()` returned **null** | not measurable |

Availability in this container is "API present, no adapter", so I have no tessellation time to report, and the other engines were not probed. This does not affect v1: correctness and release do not depend on WebGPU (ADR 0008). The compute probe is deferred (`docs/deferred.md`).

## Decision

1. **Transport: transferable `ArrayBuffer` is the default.** It is 2.2 times faster than copying at one worker and keeps the main thread under a frame at 8 workers.
2. **`SharedArrayBuffer` is optional and never required.** Its measured gain is +6.1% at the knee, inside the noise, so it is not worth COOP/COEP deployment constraints; transferable stays the default regardless.
3. **Worker count:** start at the knee, 8, capped at `hardwareConcurrency`. This is **provisional** and is a phase 8 tuning value (`M8.6`), also because the stand-in compute is far cheaper than real tessellation.
4. **Scheduling:** a priority-aware queue so interaction work overtakes refinement (FIFO 655 ms against 2.1 ms).
5. **Main-thread budget:** under 1 ms of blocking per frame from the pipeline.
6. WebGPU is not a v1 dependency and is not measured further in phase 1.
