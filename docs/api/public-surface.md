# Public surface

`src/index.ts` is the only entry. Importing it does no work: no request, no `Worker`, no GL context. A test lists every name below against the module's own keys and the generated API report (`etc/maplibre-pvec.api.md`), so a name in one and not the other fails the build.

Regenerate the report with `npm run api:report` and commit the diff. The test rebuilds it and fails on any difference.

## Entry `.`

| Name | Kind | Notes |
|---|---|---|
| `PVecAbortError` | value | Cancellation. A normal outcome, never shown to the host. |
| `PVecBackpressureError` | value | Queued work passed a cap. |
| `PVecCapabilityError` | value | A required capability is unsupported. |
| `PVecError` | value | Base class of every typed error; carries a stable `code`. |
| `PVecFormatError` | value | The bytes are not a readable container. |
| `PVecLayer` | value | The MapLibre custom layer: lifecycle, events, diagnostics, component hooks and queries. |
| `PVecLayerError` | value | Misuse of the layer: `already_added`, `disposed`. |
| `PVecOptionError` | value | A bad option value, thrown at construction. |
| `PVecTransportError` | value | The origin misbehaved. |
| `PVecVersionError` | value | The artifact changed or has no usable identity. |
| `createPVecLayer` | value | Builds a layer. Validates options, makes no request. |
| `Bounds` | type |  |
| `BytesEvent` | type |  |
| `CacheBudget` | type |  |
| `CapabilitiesEvent` | type |  |
| `CapabilityInfo` | type |  |
| `CapabilityUnsupportedEvent` | type |  |
| `ComponentKind` | type |  |
| `ComponentMap` | type |  |
| `DiagnosticsSnapshot` | type |  |
| `EntityRef` | type |  |
| `ErrorPolicy` | type |  |
| `GeoReference` | type |  |
| `GeoreferenceOptions` | type |  |
| `HatchRenderer` | type |  |
| `LayerFilter` | type |  |
| `LngLat` | type |  |
| `PVecErrorEvent` | type |  |
| `PVecEventMap` | type |  |
| `PVecEventName` | type |  |
| `PVecLayerErrorCode` | type |  |
| `PVecLayerOptions` | type |  |
| `PVecLayerUpdate` | type |  |
| `PVecListener` | type |  |
| `PVecSourceOptions` | type |  |
| `PickOptions` | type |  |
| `PickResult` | type |  |
| `RefinementEvent` | type |  |
| `ResourceLimits` | type |  |
| `StrokeStyle` | type |  |
| `StyleOptions` | type |  |
| `StyleResolver` | type |  |
| `TextRenderer` | type |  |
| `Tier0CompleteEvent` | type |  |
| `WorkerOptions` | type |  |

## Entry `./style`

Optional. Not imported by the main entry, so a geometry-only build never carries it.

| Name | Kind | Notes |
|---|---|---|
| `monochromeStyleResolver` | value |  |
| `registerStyle` | value |  |
| `StrokeStyle` | type |  |
| `StyleResolver` | type |  |

## Entry `./text`

Optional. Until a renderer is registered, text blocks are never requested.

| Name | Kind | Notes |
|---|---|---|
| `registerText` | value |  |
| `TextRenderer` | type |  |

## Entry `./hatch`

Optional. Until a renderer is registered, hatch blocks are never requested.

| Name | Kind | Notes |
|---|---|---|
| `registerHatch` | value |  |
| `HatchRenderer` | type |  |

## Deliberately not exported

The WASM module handle and its memory, worker protocol messages, `PVecSource`, the range scheduler, coalescer and tiered cache types, tessellation and buffer layouts, the buffer pool, GL resource wrappers and the GL state guard, the Tier 0 decoder and the pick pipeline interfaces. They can change in any release.

## Rules the surface keeps

- No tolerance in source units. `ErrorPolicy.displayTolerancePx` and `PickOptions.tolerancePx` are CSS pixels. Mathematical tolerances belong to the shared numeric policy (libviprs/pvec#1, P1.2).
- The only WebGPU name is `experimental.webgpu`, typed `false` (ADR 0008).
- No exported type needs `SharedArrayBuffer`. `WorkerOptions.sharedMemory` is the string `"auto"` or `"never"`.
- A hit computed against a preview generation is accurate to display fidelity, never to geometric exactness. `PickResult.generation` tells you which one you got (0 is a preview).
- `PickResult.entityId` is PVec's stable entity id. It is never a buffer index or a draw-order position.

## Events

`capabilities`, `bytes`, `tier0complete`, `refinement`, `capabilityunsupported`, `error`. A listener that throws is reported once through `error` and never reaches the render loop. Generations in `refinement` for one entity only go up.

## Errors the layer emits through `error`

`unsupported_required_capability`, `listener_failed`, `component_failed`, `layer_failed`, plus the codes of the typed errors above.
