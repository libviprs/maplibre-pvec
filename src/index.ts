/** Package entry. The production add-on lands here from phase 3 onwards. */
export const PACKAGE_NAME = "maplibre-pvec";

export { PVecSource } from "./source/PVecSource";
export type {
  CacheBudgetBytes,
  PVecBounds,
  PVecChunk,
  PVecLimits,
  PVecSourceOptions,
} from "./source/PVecSource";
export * from "./source/errors";

export { WorkerPool, defaultWorkerCount } from "./workers/pool";
export { installWorker } from "./workers/runtime";
export type { CurveEvaluator, CurveFamily } from "./workers/evaluator";
export { checkCapability } from "./workers/evaluator";
export { packCurves, CurveDataError } from "./decode/advanced";
export { Refiner } from "./refine/refiner";
export type { RefineEntity } from "./refine/refiner";
export { needsRefinement } from "./refine/policy";
export { RefineQueue } from "./refine/queue";
export { RefineCache } from "./refine/cache";
export { GenerationTracker, DrawTable } from "./refine/generation";
export { selectTessellationBackend } from "./refine/backend";
export type { BackendOptions } from "./refine/backend";
