import type { HatchRenderer } from "../components/hooks";
import type { PVecLayer } from "../layer/PVecLayer";

export type { HatchRenderer } from "../components/hooks";

/** Register a hatch renderer. Until you do, hatch blocks are never requested. */
export function registerHatch(layer: PVecLayer, renderer: HatchRenderer): () => void {
  return layer.registerComponent("hatch", renderer);
}
