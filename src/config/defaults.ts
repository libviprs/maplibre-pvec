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
