import type { TextRenderer } from "../components/hooks";
import type { PVecLayer } from "../layer/PVecLayer";

export type { TextRenderer } from "../components/hooks";

/** Register a text renderer. Until you do, text blocks are never requested. */
export function registerText(layer: PVecLayer, renderer: TextRenderer): () => void {
  return layer.registerComponent("text", renderer);
}
