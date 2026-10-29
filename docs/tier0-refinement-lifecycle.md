# Tier 0 and refinement lifecycle

1. **Tier 0.** The decoder reads the complete-coverage stream in time-sliced steps (8 ms per slice by default) and produces packed segments. Curves get a preview tessellation sized to a display budget of 2 px. The `tier0complete` event fires when coverage is complete.
2. **Policy.** Each frame, within a 1 ms budget, the policy measures the displayed error of visible entities in screen space. Above the refine threshold (1.0 px) it queues refinement, below the coarsen threshold (0.25 px) it reports a coarsen candidate. The 4x band is the hysteresis. While the camera moves the threshold is 4 px, and refinement waits 150 ms after the last camera change.
3. **Queue and pool.** A cost-aware, priority-aware queue feeds the worker pool. Buffers are transferred, never copied; shared memory is used only when `crossOriginIsolated` is true. See [ADR 0005](adr/0005-worker-model.md).
4. **Generations.** Every result carries a generation. A newer camera generation discards older in-flight work, and a stale result is never shown. Generations in `refinement` events for one entity only go up.
5. **Cache.** Refined buffers go to the refinement cache with its ceiling.

Targets and thresholds are the frozen `REFINE_DEFAULTS` and `QUEUE_DEFAULTS`.

## Limits of what is verified

The mechanics are tested in Node against an evaluator test double and a virtual clock, because no released PVec WASM artifact exists. The frame budgets are therefore the add-on's own CPU cost, not browser frame times with a compositor. Coarsening reports candidates but does not queue a job. See [deferred work](deferred.md), issue 58.
