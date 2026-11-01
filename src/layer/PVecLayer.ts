import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";
import { PVecLayerError } from "../api/errors";
import type { PVecLayerOptions, PVecLayerUpdate } from "../api/options";
import {
  CAPABILITY_OF,
  monochromeStyleResolver,
  type ComponentKind,
  type ComponentMap,
  type EntityRef,
  type StrokeStyle,
} from "../components/hooks";
import { Emitter, type DiagnosticsSnapshot, type RasterInfo, type PVecEventMap, type PVecEventName, type PVecListener } from "../diagnostics/events";
import { nearestEntity, pickPoint as corePick, queryRegion as coreRegion, type Bounds, type LngLat } from "../pick/index";
import type { PVecHandle } from "../source/bootstrap";
import { PVecCapabilityError, PVecError, PVecOptionError } from "../source/errors";
import { PVecSource } from "../source/PVecSource";
import { GlResources } from "./glresources";
import { StrokeEngine } from "./engine";
import { assertMapLibreVersion, assertWebGL2 } from "../compat/detect";
import { Tier0Decoder } from "../decode/tier0";
import type { Evaluator } from "../wasm/loader";
import { engineDepsOf, registerControl, type EngineHooks, type LayerControl, type QueryEngine } from "./internal";
import { watchContextLoss } from "../render/gl_state";

type Gl = WebGLRenderingContext | WebGL2RenderingContext;

/** One entity returned by a query. `entityId` is PVec's stable id, never a buffer index. */
export interface PickResult {
  entityId: string;
  entityType: string;
  generation: number;
  distancePx: number;
  bounds: Bounds;
  /** False while part of the searched region is not loaded. */
  complete: boolean;
}

export interface PickOptions {
  /** Extra reach in CSS pixels, added to the rendered stroke half width. A display tolerance, not a geometric one. */
  tolerancePx?: number;
}

/** Wiring state kept out of the class so the frozen API report does not list it. */
interface Wiring {
  strokes?: StrokeEngine | undefined;
  evaluator?: Evaluator | undefined;
  map?: MapLibreMap | undefined;
}
const wiring = new WeakMap<object, Wiring>();
const wired = (layer: object): Wiring => {
  let w = wiring.get(layer);
  if (!w) wiring.set(layer, (w = {}));
  return w;
};

type Phase = "idle" | "added" | "removed";

function toSource(o: PVecLayerOptions, fetchImpl: typeof fetch) {
  return {
    url: o.source.url,
    fetch: fetchImpl,
    ...(o.source.headers ? { headers: { ...o.source.headers } } : {}),
    ...(o.cache
      ? {
          cacheBudgetBytes: {
            ...(o.cache.compressedBytes !== undefined ? { compressed: o.cache.compressedBytes } : {}),
            ...(o.cache.decodedBytes !== undefined ? { decoded: o.cache.decodedBytes } : {}),
            ...(o.cache.gpuBytes !== undefined ? { gpu: o.cache.gpuBytes } : {}),
          },
        }
      : {}),
    ...(o.workers?.count !== undefined ? { workerCount: o.workers.count } : {}),
    ...(o.limits
      ? {
          limits: {
            ...(o.limits.maxDecodedBytes !== undefined ? { maxDecompressedBytes: o.limits.maxDecodedBytes } : {}),
            ...(o.limits.maxQueuedBytes !== undefined ? { maxQueuedBytes: o.limits.maxQueuedBytes } : {}),
            ...(o.limits.maxEntities !== undefined ? { maxEntities: o.limits.maxEntities } : {}),
          },
        }
      : {}),
  };
}

function validate(o: PVecLayerOptions): void {
  const tol = o.errorPolicy?.displayTolerancePx;
  if (tol !== undefined && !(Number.isFinite(tol) && tol >= 0)) {
    throw new PVecOptionError("limit-invalid", `errorPolicy.displayTolerancePx must be a finite number of at least 0, got ${String(tol)}`);
  }
  const sm = o.workers?.sharedMemory;
  if (sm !== undefined && sm !== "auto" && sm !== "never") {
    throw new PVecOptionError("worker-count-invalid", `workers.sharedMemory must be "auto" or "never", got ${String(sm)}`);
  }
  const ra = o.raster as unknown;
  if (ra !== undefined && (typeof ra !== "object" || ra === null || Array.isArray(ra))) {
    throw new PVecOptionError("raster-option-invalid", `raster must be an object like { enabled: true }, got ${String(ra)}`);
  }
  const on = o.raster?.enabled as unknown;
  if (on !== undefined && typeof on !== "boolean") {
    throw new PVecOptionError("raster-option-invalid", `raster.enabled must be true or false, got ${String(on)}`);
  }
}

/** The MapLibre custom layer that streams one .pvec artifact. Build it with {@link createPVecLayer}. */
export class PVecLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private options: PVecLayerOptions;
  private phase: Phase = "idle";
  private emitter = new Emitter();
  private glRes = new GlResources();
  private hooks: Partial<EngineHooks> = {};
  private components: { [K in ComponentKind]?: ComponentMap[K] } = {};
  private quarantine = new Set<string>();
  private cacheClear: Array<() => void> = [];
  private query: QueryEngine | undefined;
  private controller: AbortController | undefined;
  private source: PVecSource | undefined;
  private handle: PVecHandle | undefined;
  private unwatch: (() => void) | undefined;
  private ready: Promise<void> = Promise.resolve();
  private blocked = false;
  private addedAt = 0;
  private gens = new Map<string, number>();
  private n = {
    issued: 0,
    coalesced: 0,
    cancelled: 0,
    pending: 0,
    stale: 0,
    frames: 0,
    losses: 0,
    decodeMs: 0,
    tessMs: 0,
    queue: 0,
    rasterSkipped: 0,
  };

  constructor(options: PVecLayerOptions) {
    validate(options);
    this.options = options;
    this.id = options.id;
    // Resolve the options once so a bad url or budget fails here, not on the first frame. No request is made.
    new PVecSource(toSource(options, (i, init) => globalThis.fetch(i, init)));
    registerControl(this, this.control());
  }

  onAdd(_map: MapLibreMap, gl: Gl): void {
    if (this.phase === "added") throw new PVecLayerError("already_added", `layer ${this.id} is already on a map`);
    this.phase = "added";
    this.blocked = false;
    this.handle = undefined;
    wired(this).map = _map;
    this.addedAt = performance.now();
    const controller = (this.controller = new AbortController());
    const source = (this.source = new PVecSource(toSource(this.options, this.wrapFetch(controller.signal))));
    const canvas = (gl as { canvas?: unknown }).canvas as Pick<EventTarget, "addEventListener" | "removeEventListener"> | undefined;
    if (canvas && typeof canvas.addEventListener === "function") {
      this.unwatch = watchContextLoss(canvas, {
        onLost: () => {
          this.n.losses++;
          this.glRes.forgetAll();
          this.guard(() => wired(this).strokes?.onContextLost(), "context_lost");
          this.guard(() => this.hooks.onContextLost?.(), "context_lost");
        },
        onRestored: () => {
          this.guard(() => wired(this).strokes?.onContextRestored(), "context_restored");
          this.guard(() => this.hooks.onContextRestored?.(gl), "context_restored");
        },
        repaint: () => wired(this).map?.triggerRepaint?.(),
      });
    }
    this.ready = this.load(source, controller.signal, gl);
  }

  onRemove(_map: MapLibreMap, gl: Gl): void {
    if (this.phase !== "added") return;
    this.phase = "removed";
    // Order matters: stop the traffic first, then the workers that consume it, then the GPU objects,
    // then the wasm memory, then the caches that fed all of it.
    const steps: Array<[string, () => void]> = [
      ["abort", () => this.controller?.abort()],
      ["workers", () => this.hooks.terminateWorkers?.()],
      [
        "gl",
        () => {
          wired(this).strokes?.dispose();
          wired(this).strokes = undefined;
          this.glRes.disposeAll(gl);
        },
      ],
      [
        "wasm",
        () => {
          wired(this).evaluator = undefined;
          this.hooks.dropWasm?.();
        },
      ],
      [
        "cache",
        () => {
          for (const f of this.cacheClear) f();
          this.source?.cache.clear();
        },
      ],
    ];
    for (const [name, f] of steps) this.guard(f, `teardown_${name}`);
    this.unwatch?.();
    this.unwatch = undefined;
    this.query = undefined;
    this.source = undefined;
    this.controller = undefined;
    wired(this).map = undefined;
  }

  render(gl: Gl, args: unknown): void {
    if (this.phase !== "added" || this.blocked) return;
    this.n.frames++;
    const custom = this.hooks.render;
    this.guard(() => (custom ? custom(gl, args) : wired(this).strokes?.render()), "render");
  }

  /** Resolves when the first bootstrap has finished, whether it worked or not. Never rejects. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Change georeference, limits, cache, errorPolicy or style. Nothing here refetches canonical bytes. */
  update(partial: PVecLayerUpdate): void {
    const next = { ...this.options, ...partial };
    validate(next);
    new PVecSource(toSource(next, (i, init) => globalThis.fetch(i, init)));
    this.options = next;
    if ("georeference" in partial) wired(this).strokes?.setReference(next.georeference?.reference);
    if (partial.raster) wired(this).strokes?.setRasterEnabled(next.raster?.enabled !== false);
    this.hooks.onUpdate?.(partial);
  }

  on<K extends PVecEventName>(type: K, fn: PVecListener<K>): this {
    this.emitter.on(type, fn);
    return this;
  }
  off<K extends PVecEventName>(type: K, fn: PVecListener<K>): this {
    this.emitter.off(type, fn);
    return this;
  }
  once<K extends PVecEventName>(type: K, fn: PVecListener<K>): this {
    this.emitter.once(type, fn);
    return this;
  }

  /**
   * The rasters that draw, in RasterId order, empty before the file is loaded or when it has none. A custom layer has no
   * source to carry an attribution, so the host passes `attribution` (already escaped) to MapLibre's attribution control.
   */
  rasters(): RasterInfo[] {
    return wired(this).strokes?.rasterInfos() ?? [];
  }

  getDiagnostics(): DiagnosticsSnapshot {
    const s = this.source?.stats;
    const c = this.source?.cache;
    return {
      ranges: { requested: this.n.issued + this.n.coalesced, issued: this.n.issued, coalesced: this.n.coalesced },
      bytes: {
        fetched: s?.bytes ?? 0,
        decoded: 0,
        compressedTier: c?.bytes("compressed") ?? 0,
        decodedTier: c?.bytes("decoded") ?? 0,
        gpuTier: c?.bytes("gpu") ?? 0,
      },
      timingMs: { decode: this.n.decodeMs, tessellation: this.n.tessMs },
      workerQueueDepth: this.n.queue,
      discardedStaleGenerations: this.n.stale,
      cancelledWork: this.n.cancelled,
      pendingFetches: this.n.pending,
      frames: this.n.frames,
      contextLosses: this.n.losses,
      rasters: { drawn: this.rasters().length, skipped: this.n.rasterSkipped, ...(wired(this).strokes?.rasterAccounting() ?? { textureBytes: 0, decodesInFlight: 0 }) },
    };
  }

  /** Attach a component hook. Returns the function that removes it again. */
  registerComponent<K extends ComponentKind>(kind: K, impl: ComponentMap[K]): () => void {
    this.components[kind] = impl as never;
    this.hooks.onComponentChange?.(kind);
    return () => {
      if (this.components[kind] === impl) {
        delete this.components[kind];
        this.hooks.onComponentChange?.(kind);
      }
    };
  }
  /** Capability names whose blocks are worth fetching, given the hooks registered now. Sorted. */
  wantedCapabilities(): string[] {
    return (Object.keys(this.components) as ComponentKind[]).map((k) => CAPABILITY_OF[k]).sort();
  }
  /** The style for an entity. A resolver that throws is reported once per entity and the default is used. */
  resolveStyle(entity: EntityRef): StrokeStyle {
    const r = this.components.style;
    const dflt = (): StrokeStyle => {
      const base = monochromeStyleResolver(entity);
      const s = this.options.style;
      return { ...base, widthPx: s?.defaultStrokeWidthPx ?? base.widthPx, color: s?.defaultColor ?? base.color };
    };
    if (!r) return dflt();
    try {
      return r.resolve(entity);
    } catch (e) {
      this.componentFailed("style", entity.entityId, e);
      return dflt();
    }
  }
  /** Whether the layer filter keeps the entity. No filter, or a throwing one, keeps it. */
  isEntityVisible(entity: EntityRef): boolean {
    const f = this.components.layerFilter;
    if (!f) return true;
    try {
      return f.visible(entity);
    } catch (e) {
      this.componentFailed("layerFilter", entity.entityId, e);
      return true;
    }
  }

  /** Entities under a point. Empty when nothing is within the stroke half width plus `tolerancePx`. */
  pickPoint(at: LngLat, options: PickOptions = {}): PickResult[] {
    const q = this.engine();
    const tol = options.tolerancePx ?? 0;
    const res = corePick(q, at, { radiusPx: q.maxCandidateRadiusPx });
    return res.hits
      .filter((h) => h.distancePx <= q.halfWidthPx(h.entityId) + tol && !q.quarantined(h.entityId))
      .map((h) => this.toResult(q, h, res.complete));
  }
  /** Every non-quarantined entity touching the region, once each. */
  queryRegion(bounds: Bounds): PickResult[] {
    const q = this.engine();
    const res = coreRegion(q, bounds);
    const seen = new Set<string>();
    const out: PickResult[] = [];
    for (const h of res.hits) {
      if (seen.has(h.entityId) || q.quarantined(h.entityId)) continue;
      seen.add(h.entityId);
      out.push(this.toResult(q, h, res.complete));
    }
    return out;
  }
  nearestEntity(at: LngLat, radiusPx: number): PickResult | undefined {
    const q = this.engine();
    const n = nearestEntity(q, at, { maxRadiusPx: radiusPx });
    return n.hit && !q.quarantined(n.hit.entityId) ? this.toResult(q, n.hit, n.complete) : undefined;
  }
  /** Provenance and component data, or undefined when the file lacks them or no hook is registered. */
  resolveProvenance(entityId: string): unknown {
    const q = this.engine();
    const declared = this.handle?.manifest.capabilities.some((c) => c.name === "source_provenance") ?? false;
    if (!declared || this.wantedCapabilities().length === 0) return undefined;
    return q.provenance?.(entityId);
  }

  private toResult(q: QueryEngine, h: { entityId: string; entityType: string; generation: number; distancePx: number }, complete: boolean): PickResult {
    return { ...h, bounds: q.boundsOf(h.entityId), complete: complete && q.tier0Complete() };
  }
  private engine(): QueryEngine {
    if (this.phase !== "added") throw new PVecLayerError("disposed", `layer ${this.id} is not on a map`);
    if (!this.query) throw new PVecLayerError("disposed", `layer ${this.id} has no loaded index yet`);
    return this.query;
  }

  private async load(source: PVecSource, signal: AbortSignal, gl: Gl): Promise<void> {
    const deps = engineDepsOf(this);
    try {
      // Everything that can refuse does so before the first range request.
      const version = deps.maplibreVersion();
      if (version !== undefined) assertMapLibreVersion(version);
      assertWebGL2(gl);
      const evaluator = await deps.loadEvaluator();
      if (signal.aborted) return;
      wired(this).evaluator = evaluator;
      const h = await source.bootstrap();
      if (signal.aborted) return;
      this.handle = h;
      const m = h.manifest;
      const opened = await deps.openRasters(h, evaluator, source);
      // A raster stream the module refused as a whole holds no rasters: the layer treats it as a file without any, as it always has.
      const rasters = opened?.refusedStream ? null : opened;
      if (signal.aborted) return;
      this.emitter.emit("capabilities", {
        minReader: m.minReader.join("."),
        capabilities: m.capabilities.map((c) => ({ name: c.name, major: c.major, minor: c.minor, patch: c.patch, required: c.required })),
        unsupportedRequired: [],
        unsupportedOptional: h.report.unsupportedOptional.filter((c) => c.name !== "raster" || !rasters).map((c) => c.name),
      });
      // A module that can read the raster stream has not left it unsupported.
      for (const c of h.report.unsupportedOptional) {
        if (c.name === "raster" && rasters) continue;
        this.emitter.emit("capabilityunsupported", { capability: c.name, required: false, action: "ignored" });
      }
      this.emitter.emit("bytes", {
        rangesRequested: this.n.issued + this.n.coalesced,
        rangesIssued: this.n.issued,
        rangesCoalesced: this.n.coalesced,
        bytesFetched: source.stats.bytes,
        bytesDecoded: 0,
        cacheTier: "network",
      });
      const cursor = await deps.openCursor(h, evaluator, source);
      const map = wired(this).map;
      if (signal.aborted || (!cursor && !rasters) || !map) return;
      const engine = (wired(this).strokes = new StrokeEngine({
        gl: gl as WebGL2RenderingContext,
        map,
        res: this.glRes,
        reference: this.options.georeference?.reference,
        style: (entityId) => this.resolveStyle({ entityId }),
        visible: (entityId) => this.isEntityVisible({ entityId }),
        onStateDiff: deps.onStateDiff,
        cache: source.cache,
        rasters: rasters ?? undefined,
        maxDecodedBytes: this.options.limits?.maxDecodedBytes,
        onRasterSkipped: (e) => (this.n.rasterSkipped++, this.emitter.emit("rasterskipped", e)),
        onRasterFrame: deps.onRasterFrame,
        onRasterDecode: deps.onRasterDecode,
        spawnDecode: deps.spawnDecode,
        onError: (where, err) => this.emitter.emit("error", { code: "layer_failed", message: `${where}: ${String(err)}`, context: { where } }),
      }));
      engine.setRasterEnabled(this.options.raster?.enabled !== false);
      if (cursor) {
        const t0 = performance.now();
        const draws = new Tier0Decoder().decodeAll(cursor);
        this.n.decodeMs += performance.now() - t0;
        this.guard(() => engine.setDraws(draws), "upload");
      } else {
        map.triggerRepaint?.();
      }
    } catch (e) {
      if (signal.aborted) return;
      this.blocked = true;
      if (e instanceof PVecCapabilityError) {
        this.emitter.emit("capabilityunsupported", { capability: e.capability, required: true, action: "refused" });
        this.emitter.emit("error", { code: "unsupported_required_capability", message: e.message, context: { capability: e.capability, cause: e.code } });
      } else {
        this.emitter.emit("error", { code: e instanceof PVecError ? e.code : "load_failed", message: String(e instanceof Error ? e.message : e), context: e instanceof PVecError ? { ...e.detail } : {} });
      }
    }
  }

  private wrapFetch(signal: AbortSignal): typeof fetch {
    const user = this.options.source.fetch ?? ((i: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(i, init));
    const auth = this.options.source.auth;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      this.n.issued++;
      this.n.pending++;
      try {
        if (auth) await auth({ url: String(input), headers });
        const merged = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
        return await user(input, { ...init, headers, signal: merged });
      } catch (e) {
        if (signal.aborted) this.n.cancelled++;
        throw e;
      } finally {
        this.n.pending--;
      }
    }) as typeof fetch;
  }

  private componentFailed(kind: ComponentKind, entityId: string, e: unknown): void {
    if (this.quarantine.has(`${kind}:${entityId}`)) return;
    this.quarantine.add(`${kind}:${entityId}`);
    this.emitter.emit("error", { code: "component_failed", message: `${kind} hook threw: ${String(e)}`, context: { kind, entityId } });
  }

  private guard(f: () => void, where: string): void {
    try {
      f();
    } catch (e) {
      this.emitter.emit("error", { code: "layer_failed", message: `${where}: ${String(e)}`, context: { where } });
    }
  }

  private control(): LayerControl {
    return {
      gl: this.glRes,
      setHooks: (h) => void Object.assign(this.hooks, h),
      attachQuery: (e) => void (this.query = e),
      signal: () => this.controller?.signal,
      onCacheClear: (fn) => void this.cacheClear.push(fn),
      markTier0Complete: (e) => this.emitter.emit("tier0complete", { ...e, msSinceAdd: performance.now() - this.addedAt }),
      reportRefinement: (e: PVecEventMap["refinement"]) => {
        const prev = this.gens.get(e.entityId) ?? 0;
        if (e.generation <= prev) {
          this.n.stale++;
          return;
        }
        this.gens.set(e.entityId, e.generation);
        this.emitter.emit("refinement", e);
      },
      reportCapabilityUnsupported: (e) => this.emitter.emit("capabilityunsupported", e),
      reportRasterSkipped: (e) => this.emitter.emit("rasterskipped", e),
      reportError: (code, message, context) => this.emitter.emit("error", { code, message, context }),
      reportBytes: (e) => this.emitter.emit("bytes", e),
      addTiming: (kind, ms) => void (kind === "decode" ? (this.n.decodeMs += ms) : (this.n.tessMs += ms)),
      setWorkerQueueDepth: (n) => void (this.n.queue = n),
      addCoalesced: (n) => void (this.n.coalesced += n),
    };
  }
}

/** Build a layer. Validates the options, makes no request and creates no worker or GL context. */
export function createPVecLayer(options: PVecLayerOptions): PVecLayer {
  return new PVecLayer(options);
}
