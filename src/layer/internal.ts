import type { BytesEvent, PVecErrorEvent, PVecEventMap } from "../diagnostics/events";
import type { ComponentKind } from "../components/hooks";
import type { Bounds, PickContext } from "../pick/index";
import type { PVecLayerUpdate } from "../api/options";
import { loadEvaluator } from "../wasm/loader";
import type { GlResources } from "./glresources";
import type { Evaluator } from "../wasm/loader";
import type { BlockCursor } from "../decode/tier0";
import type { PVecHandle } from "../source/bootstrap";

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

const engineDefaults: EngineDeps = {
  loadEvaluator: () => loadEvaluator(),
  maplibreVersion: () => (globalThis as { maplibregl?: { getVersion?: () => string } }).maplibregl?.getVersion?.(),
  // The packed Tier 0 decoder is part of the shared evaluator (libviprs/pvec#1, P7.2). Until it ships there is nothing to drive.
  openCursor: () => Promise.resolve(null),
};
const engineOverrides = new WeakMap<object, Partial<EngineDeps>>();
/** Replace parts of the engine's dependencies for one layer. Call before `onAdd`. */
export function configureEngine(layer: object, deps: Partial<EngineDeps>): void {
  engineOverrides.set(layer, { ...engineOverrides.get(layer), ...deps });
}
/** Replace the defaults for every layer built afterwards or not yet configured. Returns the function that restores them. */
export function setEngineDefaults(deps: Partial<EngineDeps>): () => void {
  const prev = { ...engineDefaults };
  Object.assign(engineDefaults, deps);
  return () => void Object.assign(engineDefaults, prev);
}
export function engineDepsOf(layer: object): EngineDeps {
  return { ...engineDefaults, ...engineOverrides.get(layer) };
}

/**
 * What the wired layer needs from outside the add-on. The defaults are the real ones. The tests (and,
 * until the shared evaluator ships a Tier 0 decoder, the browser specs) inject stand-ins per layer.
 */
export interface EngineDeps {
  /** Acquire the WASM evaluator. A rejection is a `wasm_unavailable` PVecError. */
  loadEvaluator(): Promise<Evaluator>;
  /** The MapLibre version string, or undefined when it cannot be read (the check is then skipped). */
  maplibreVersion(): string | undefined;
  /** A cursor over the Tier 0 blocks, or null when the evaluator offers no decoder to drive. */
  openCursor(handle: PVecHandle, evaluator: Evaluator): Promise<BlockCursor | null>;
  /** Debug hook: names of GL state the guard found changed after a frame. Turns the guard's debug mode on. */
  onStateDiff?: (names: string[]) => void;
}
