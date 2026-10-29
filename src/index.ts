/**
 * The one public entry of @libviprs/maplibre-pvec. Importing it has no side effects: no request,
 * no Worker, no GL context. Everything not listed here is internal and may change.
 */
export { PVecLayer, createPVecLayer } from "./layer/PVecLayer";
export type { PickOptions, PickResult } from "./layer/PVecLayer";
export type {
  CacheBudget,
  ErrorPolicy,
  GeoreferenceOptions,
  PVecLayerOptions,
  PVecLayerUpdate,
  PVecSourceOptions,
  ResourceLimits,
  StyleOptions,
  WorkerOptions,
} from "./api/options";
export { PVecLayerError } from "./api/errors";
export type { PVecLayerErrorCode } from "./api/errors";
export {
  PVecAbortError,
  PVecBackpressureError,
  PVecCapabilityError,
  PVecError,
  PVecFormatError,
  PVecOptionError,
  PVecTransportError,
  PVecVersionError,
} from "./source/errors";
export type {
  BytesEvent,
  CapabilitiesEvent,
  CapabilityInfo,
  CapabilityUnsupportedEvent,
  DiagnosticsSnapshot,
  PVecErrorEvent,
  PVecEventMap,
  PVecEventName,
  PVecListener,
  RefinementEvent,
  Tier0CompleteEvent,
} from "./diagnostics/events";
export type {
  ComponentKind,
  ComponentMap,
  EntityRef,
  HatchRenderer,
  LayerFilter,
  StrokeStyle,
  StyleResolver,
  TextRenderer,
} from "./components/hooks";
export type { GeoReference } from "./transform/georeference";
export type { Bounds, LngLat } from "./pick/index";
