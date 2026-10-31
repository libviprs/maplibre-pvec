export const EVENT_NAMES = ["capabilities", "bytes", "tier0complete", "refinement", "capabilityunsupported", "rasterskipped", "error"] as const;
export type PVecEventName = (typeof EVENT_NAMES)[number];

export interface CapabilityInfo {
  name: string;
  major: number;
  minor: number;
  patch: number;
  required: boolean;
}
export interface CapabilitiesEvent {
  /** Lowest reader version the file asks for, as "major.minor.patch". */
  minReader: string;
  capabilities: CapabilityInfo[];
  unsupportedRequired: string[];
  unsupportedOptional: string[];
}
export interface BytesEvent {
  rangesRequested: number;
  rangesIssued: number;
  rangesCoalesced: number;
  bytesFetched: number;
  bytesDecoded: number;
  cacheTier: "network" | "compressed" | "decoded" | "gpu";
}
export interface Tier0CompleteEvent {
  viewportId: string;
  msSinceAdd: number;
  blocksUsed: number;
}
export interface RefinementEvent {
  entityId: string;
  generation: number;
  priorErrorPx: number;
  nextErrorPx: number;
}
export interface CapabilityUnsupportedEvent {
  capability: string;
  required: boolean;
  action: string;
}
/** One raster the reader did not draw. Emitted once per skipped raster per bootstrap; the file's other rasters and its strokes draw. */
export interface RasterSkippedEvent {
  rasterId: number;
  /** The rule that refused it, such as `RASTER-04`. */
  rule: string;
  message: string;
}
export interface PVecErrorEvent {
  code: string;
  message: string;
  context: Record<string, unknown>;
}

export interface PVecEventMap {
  capabilities: CapabilitiesEvent;
  bytes: BytesEvent;
  tier0complete: Tier0CompleteEvent;
  refinement: RefinementEvent;
  capabilityunsupported: CapabilityUnsupportedEvent;
  rasterskipped: RasterSkippedEvent;
  error: PVecErrorEvent;
}

export type PVecListener<K extends PVecEventName> = (event: PVecEventMap[K]) => void;

/** Typed emitter. A throwing listener is reported once through `error` and never reaches the caller. */
export class Emitter {
  private listeners = new Map<PVecEventName, Set<(e: never) => void>>();

  on<K extends PVecEventName>(type: K, fn: PVecListener<K>): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn as (e: never) => void);
  }
  off<K extends PVecEventName>(type: K, fn: PVecListener<K>): void {
    this.listeners.get(type)?.delete(fn as (e: never) => void);
  }
  once<K extends PVecEventName>(type: K, fn: PVecListener<K>): void {
    const wrapper: PVecListener<K> = (e) => {
      this.off(type, wrapper);
      fn(e);
    };
    this.on(type, wrapper);
  }
  clear(): void {
    this.listeners.clear();
  }
  emit<K extends PVecEventName>(type: K, event: PVecEventMap[K]): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      try {
        (fn as PVecListener<K>)(event);
      } catch (e) {
        if (type === "error") continue;
        this.emit("error", { code: "listener_failed", message: `a ${type} listener threw: ${String(e)}`, context: { event: type } });
      }
    }
  }
}

/** What the host needs to know about a raster that draws. `attribution` is already escaped for an HTML sink. */
export interface RasterInfo {
  id: number;
  width: number;
  height: number;
  /** 0 draws under the strokes, 1 over them. */
  band: 0 | 1;
  /** 0 to 255. */
  opacity: number;
  /** Plain text escaped for MapLibre's attribution control, empty when the raster has none. */
  attribution: string;
}

export interface DiagnosticsSnapshot {
  ranges: { requested: number; issued: number; coalesced: number };
  bytes: { fetched: number; decoded: number; compressedTier: number; decodedTier: number; gpuTier: number };
  timingMs: { decode: number; tessellation: number };
  workerQueueDepth: number;
  discardedStaleGenerations: number;
  cancelledWork: number;
  pendingFetches: number;
  frames: number;
  contextLosses: number;
}
