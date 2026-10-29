/** Optional component hooks. Geometry never depends on them and they never change geometry. */

export interface EntityRef {
  entityId: string;
}
export interface StrokeStyle {
  widthPx: number;
  dash: readonly number[];
  color: string;
}
export interface StyleResolver {
  resolve(entity: EntityRef): StrokeStyle;
}
export interface LayerFilter {
  visible(entity: EntityRef): boolean;
}
export interface TextRenderer {
  render(entity: EntityRef): void;
}
export interface HatchRenderer {
  render(entity: EntityRef): void;
}

export interface ComponentMap {
  style: StyleResolver;
  layerFilter: LayerFilter;
  text: TextRenderer;
  hatch: HatchRenderer;
}
export type ComponentKind = keyof ComponentMap;

/** The PVec capability whose blocks a hook of this kind needs. */
export const CAPABILITY_OF: Record<ComponentKind, string> = {
  style: "line_style",
  layerFilter: "layer",
  text: "text",
  hatch: "hatch",
};

/** The reference resolver: one monochrome stroke for every entity. Also the default with no resolver. */
export function monochromeStyleResolver(_entity: EntityRef): StrokeStyle {
  return { widthPx: 1, dash: [], color: "#000000" };
}
