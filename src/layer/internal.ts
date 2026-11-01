import type { BytesEvent, PVecErrorEvent, PVecEventMap } from "../diagnostics/events";
import type { ComponentKind } from "../components/hooks";
import type { Bounds, PickContext } from "../pick/index";
import type { PVecLayerUpdate } from "../api/options";
import { loadEvaluator } from "../wasm/loader";
import { openRasterProvider, type RangeReader } from "../wasm/raster";
import type { GlResources } from "./glresources";
import type { Evaluator } from "../wasm/loader";
import type { BlockCursor } from "../decode/tier0";
import type { PVecHandle } from "../source/bootstrap";
import type { PVecSource } from "../source/PVecSource";
import { openTier0Cursor } from "./tier0-cursor";
import type { DecodeWorker } from "../render/raster/decode";
import type { RasterProvider } from "../render/raster/provider";
import type { RasterFrameStats } from "../render/raster/renderer";

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
  reportRasterSkipped(e: PVecEventMap["rasterskipped"]): void;
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
  openCursor: (handle, evaluator, source) => openTier0Cursor(handle, evaluator, source),
  // The raster stream of the file through the module's exports (libviprs/pvec#221). Null when the file declares no raster, or the
  // module predates the exports, and the layer then draws as it did before.
  openRasters: (handle, evaluator, source) =>
    handle.manifest.capabilities.some((c) => c.name === "raster") ? openRasterProvider(evaluator, source) : Promise.resolve(null),
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
  openCursor(handle: PVecHandle, evaluator: Evaluator, source: PVecSource): Promise<BlockCursor | null>;
  /** The raster stream of the file behind a seam, or null when the module lacks the raster exports or the file has no raster. */
  openRasters(handle: PVecHandle, evaluator: Evaluator, source: RangeReader): Promise<RasterProvider | null>;
  /** Debug hooks of the raster path: per frame stats, per tile decode time, and the worker the decode runs in. */
  onRasterFrame?: (s: RasterFrameStats) => void;
  onRasterDecode?: (e: { id: number; codec: number; ms: number }) => void;
  spawnDecode?: () => DecodeWorker;
  /** Debug hook: names of GL state the guard found changed after a frame. Turns the guard's debug mode on. */
  onStateDiff?: (names: string[]) => void;
}
