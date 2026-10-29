/** Provisional defaults, owned by the tuning work in M8.6 and M8.7. */
export const DEFAULTS = {
  /** Maximum entities one Tier 0 block may carry before decode refuses it. */
  maxEntitiesPerBlock: 200_000,
  /** Wall-clock budget of one decode slice, in milliseconds. */
  maxDecodeSliceMs: 8,
  /** Preview tessellation budget in device pixels (refined target is 0.5). */
  previewBudgetPx: 2.0,
  previewMaxIterations: 12,
  /** Buffer pool. */
  arenaPageBytes: 4 * 1024 * 1024,
  uploadBudgetBytes: 4 * 1024 * 1024,
  uploadBudgetMs: 2,
  compactAboveFragmentation: 0.35,
  /** Pick radius in device pixels. */
  pickRadiusPx: 4,
  miterLimit: 4,
} as const;

/**
 * Display-fidelity budget in device px, owned by this repository (not a mathematical tolerance;
 * those come from the shared numeric policy, libviprs/pvec#1 P1.2). Provisional until M8.6 tunes
 * it and M8.7 freezes it.
 */
export const DISPLAY_FIDELITY_TARGET_PX = 0.5;

/** Maximum adaptive subdivision depth before the evaluator reports its residual instead. */
export const MAX_SUBDIVISION_DEPTH = 24;

/** Documented precision envelope. Outside it the add-on emits a diagnostic. */
export const PRECISION_ENVELOPE = Object.freeze({
  maxSourceMagnitude: 1e7,
  maxZoom: 22,
  maxLatitude: 84,
});
