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

/** Refinement policy (M6.3). Provisional until M8.6 tunes them and M8.7 freezes them. */
export const REFINE_DEFAULTS = Object.freeze({
  /** Target error of a refined tessellation, device px. */
  targetPx: 0.5,
  /** Refine when the evaluated error exceeds this. */
  refinePx: 1.0,
  /** Coarsen below this. The 4x band to refinePx is the hysteresis. */
  coarsenPx: 0.25,
  /** Refine threshold while the camera is moving. */
  navigatingPx: 4.0,
  /** Idle delay after the last camera change, ms. */
  idleMs: 150,
  /** Policy evaluation budget per frame, ms. */
  policyBudgetMs: 1,
  /** Parameters sampled per entity when measuring the displayed error. */
  measureSamples: 96,
});

/** Cost-aware queue and dispatch budgets (M6.4). Provisional until M8.6. */
export const QUEUE_DEFAULTS = Object.freeze({
  maxInFlight: 8,
  perWorkerInFlight: 2,
  perWorkerBytes: 2 * 1024 * 1024,
  /** Target granularity of one job, ms of estimated work. */
  jobTargetMs: 20,
  maxDepth: 4096,
  /** Main-thread scheduling cost per frame, ms. */
  scheduleBudgetMs: 0.5,
  /** Placeholder calibration, ns per control-point-degree evaluation unit, until M1.3 can be measured on the real evaluator. */
  nsPerCostUnit: 400,
});

/** Refinement cache ceiling (M6.6). Provisional until M8.6. */
export const CACHE_DEFAULTS = Object.freeze({
  maxBytes: 48 * 1024 * 1024,
  maxEntries: 4096,
  /** Zoom bucket width, in zoom levels. */
  zoomBucketWidth: 0.25,
  /** Device pixel ratio bucket width. */
  dprBucketWidth: 0.25,
});

/** Worker pool (M6.2). */
export const POOL_DEFAULTS = Object.freeze({ minWorkers: 1, maxWorkers: 4 });

/** LIMIT-16 on the host side: the default cap on decoded bytes. The source's decompression limit and the raster renderer's bitmaps in flight share it. */
export const DEFAULT_MAX_DECODED_BYTES = 256 * 1024 * 1024;

/**
 * The texture bound of the raster pass (ADR 0009) as three numbers. The bound is
 * `tiles in view * retainedLevelFactor * edge * edge * bytesPerTexel`, summed over the rasters drawn, and it must fit
 * `textureShare` of the `gpu` tier (`cache.gpuBytes`, 128 MiB by default). Measured in #108 (`docs/raster-render.md`):
 * a tile is uploaded as RGBA8 without mipmaps, so a texel is 4 bytes on every renderer; the coarser level kept under a
 * finer one doubles the tiles in view and no more; textures are the only users of the `gpu` tier, so the share is the whole
 * of it. A two-scan view at 1080p and at 4K stayed under the ceiling on the renderers named in `release/v1-freeze.json`
 * (`rasterProvenance`), with the fit rule stepping a level down where two full-resolution views do not fit. Software GL
 * runs are relative costs and do not feed these values.
 */
export const RASTER_DEFAULTS = Object.freeze({
  bytesPerTexel: 4,
  retainedLevelFactor: 2,
  textureShare: 1,
});
