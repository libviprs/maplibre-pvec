import type { GeoReference } from "../transform/georeference";

/** Where the artifact lives and how to reach it. */
export interface PVecSourceOptions {
  /** Absolute URL of the .pvec artifact. */
  url: string;
  /** Fetch implementation for signing or instrumentation. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Static headers merged into every range request. */
  headers?: Readonly<Record<string, string>>;
  /** Called before every request. It may add headers (a token, a signature) to `request.headers`. */
  auth?: (request: { readonly url: string; headers: Record<string, string> }) => void | Promise<void>;
}

/** Where the drawing sits on the map. Never read from, or written to, the file. */
export interface GeoreferenceOptions {
  reference: GeoReference;
}

/** Caps on what the browser may hold. Omitted fields keep the browser preset. */
export interface ResourceLimits {
  maxDecodedBytes?: number;
  maxQueuedBytes?: number;
  maxEntities?: number;
}

/** Per-tier cache ceilings in bytes. */
export interface CacheBudget {
  compressedBytes?: number;
  decodedBytes?: number;
  gpuBytes?: number;
}

export interface WorkerOptions {
  /** Pool size. Defaults from the core count. */
  count?: number;
  sharedMemory?: "auto" | "never";
}

/** A display budget in CSS pixels. It is not a mathematical tolerance and never has source units. */
export interface ErrorPolicy {
  displayTolerancePx?: number;
}

export interface StyleOptions {
  /** Stroke width in CSS pixels when no style component applies. */
  defaultStrokeWidthPx?: number;
  /** CSS colour when no style component applies. */
  defaultColor?: string;
}

export interface PVecLayerOptions {
  /** The MapLibre layer id. */
  id: string;
  source: PVecSourceOptions;
  georeference?: GeoreferenceOptions;
  limits?: ResourceLimits;
  cache?: CacheBudget;
  workers?: WorkerOptions;
  errorPolicy?: ErrorPolicy;
  style?: StyleOptions;
  /** Not supported. The only accepted value is false (ADR 0008). */
  experimental?: {
    readonly webgpu?: false;
  };
}

/** What `layer.update()` accepts. None of it refetches canonical bytes. */
export type PVecLayerUpdate = Pick<PVecLayerOptions, "georeference" | "limits" | "cache" | "errorPolicy" | "style">;
