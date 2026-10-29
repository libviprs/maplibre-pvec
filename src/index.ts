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
export { assertMapLibreVersion, assertWebGL2 } from "./compat/detect";
