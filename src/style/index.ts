import { monochromeStyleResolver } from "../components/hooks";
import type { StyleResolver } from "../components/hooks";
import type { PVecLayer } from "../layer/PVecLayer";

export { monochromeStyleResolver } from "../components/hooks";
export type { StrokeStyle, StyleResolver } from "../components/hooks";

/** Register the monochrome resolver, or your own, on a layer. Returns the unregister function. */
export function registerStyle(layer: PVecLayer, resolver: StyleResolver = { resolve: monochromeStyleResolver }): () => void {
  return layer.registerComponent("style", resolver);
}
