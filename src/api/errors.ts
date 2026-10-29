import { PVecError } from "../source/errors";

export type PVecLayerErrorCode = "already_added" | "disposed";

/** Misuse of the layer itself: adding it twice, or querying it after removal. */
export class PVecLayerError extends PVecError {
  declare readonly code: PVecLayerErrorCode;
  constructor(code: PVecLayerErrorCode, message: string) {
    super(code, message);
  }
}
