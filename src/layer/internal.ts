import type { BytesEvent, PVecErrorEvent, PVecEventMap } from "../diagnostics/events";
import type { ComponentKind } from "../components/hooks";
import type { Bounds, PickContext } from "../pick/index";
import type { PVecLayerUpdate } from "../api/options";
import type { GlResources } from "./glresources";

/** Everything the query API needs beyond the pick context. */
export interface QueryEngine extends PickContext {
  boundsOf(entityId: string): Bounds;
  /** Rendered stroke half width in CSS pixels. */
  halfWidthPx(entityId: string): number;
  tier0Complete(): boolean;
  quarantined(entityId: string): boolean;
  /** Provenance and component data, when the file carries them. */
  provenance?(entityId: string): unknown;
}

export interface EngineHooks {
  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: unknown): void;
  onContextLost(): void;
  onContextRestored(gl: WebGLRenderingContext | WebGL2RenderingContext): void;
  terminateWorkers(): void;
  dropWasm(): void;
  onComponentChange(kind: ComponentKind): void;
  onUpdate(partial: PVecLayerUpdate): void;
}

/** The seam the rest of the add-on (and the tests) use to drive a layer. Not exported from the package. */
export interface LayerControl {
  gl: GlResources;
  setHooks(h: Partial<EngineHooks>): void;
  attachQuery(e: QueryEngine): void;
  /** The abort signal of the current add, undefined when not added. */
  signal(): AbortSignal | undefined;
  onCacheClear(fn: () => void): void;
  markTier0Complete(e: { viewportId: string; blocksUsed: number }): void;
  reportRefinement(e: PVecEventMap["refinement"]): void;
  reportCapabilityUnsupported(e: PVecEventMap["capabilityunsupported"]): void;
  reportError(code: string, message: string, context: PVecErrorEvent["context"]): void;
  reportBytes(e: BytesEvent): void;
  addTiming(kind: "decode" | "tessellation", ms: number): void;
  setWorkerQueueDepth(n: number): void;
  addCoalesced(n: number): void;
}

const controls = new WeakMap<object, LayerControl>();
export function registerControl(layer: object, c: LayerControl): void {
  controls.set(layer, c);
}
export function controlOf(layer: object): LayerControl {
  const c = controls.get(layer);
  if (!c) throw new Error("not a PVecLayer");
  return c;
}
export type { BytesEvent };
