/**
 * The one source for the compatibility matrix. docs/compatibility.md, compatibility.json and the
 * package.json peer range are all derived from this file (npm run compat:generate / compat:check).
 */
export interface MapLibreRow {
  readonly version: string;
  /** Shape of the second argument to the custom layer's render and prerender. */
  readonly renderArgs: string;
  readonly context: "WebGL2RenderingContext";
  /** Measured in docs/spikes/01-maplibre-surface.md, Chromium only. */
  readonly verified: string;
}
export interface BrowserRow {
  readonly engine: "chromium" | "firefox" | "webkit";
  readonly status: "supported" | "pending";
  readonly tested: string;
  readonly note: string;
}
export interface ProjectionRow {
  readonly id: string;
  readonly state: "conformant" | "experimental" | "unsupported";
  readonly baseline: boolean;
}
export interface UnsupportedRow {
  readonly id: string;
  readonly combination: string;
  /** The typed `code` the refusal carries, or "degrade" when the add-on keeps going. */
  readonly code: string;
  readonly outcome: string;
}

export const COMPAT = {
  maplibre: [
    { version: "4.7.1", renderArgs: "number[16] (the matrix)", context: "WebGL2RenderingContext", verified: "onAdd context, matrix convention within 1 device px, state left set" },
    { version: "5.24.0", renderArgs: "object with defaultProjectionData.mainMatrix", context: "WebGL2RenderingContext", verified: "onAdd context, matrix convention within 1 device px, state left set" },
    { version: "6.16.0", renderArgs: "object with defaultProjectionData.mainMatrix (plus getProjectionData)", context: "WebGL2RenderingContext", verified: "onAdd context, matrix convention within 1 device px, state left set" },
  ] as readonly MapLibreRow[],
  browsers: [
    { engine: "chromium", status: "supported", tested: "130.0.6723.31", note: "WebGL2 through ANGLE on SwiftShader in CI; module workers; no COOP/COEP needed" },
    { engine: "firefox", status: "pending", tested: "none", note: "the CI container's Firefox returned no WebGL2 context, so no minimum is claimed until the M2.8 grid has a Firefox row" },
    { engine: "webkit", status: "pending", tested: "none", note: "no minimum is claimed until the M2.8 grid has a WebKit row" },
  ] as readonly BrowserRow[],
  browserRequirements: {
    webgl2: "required, no canvas2D fallback",
    wasmFeatures: "WebAssembly MVP only; no threads, no SIMD, no bulk memory required by the shipped module",
    moduleWorkers: "required for the worker transfer path",
    crossOriginIsolation: "never required; shared memory is used only when crossOriginIsolated is true",
  },
  pvec: {
    readerVersion: "1.0.0",
    semanticProfile: "geometry major 1",
    requiredCapabilities: ["cartesian_point", "direction_vector", "axis_placement_2d", "line", "polyline", "circle", "ellipse", "trimmed_curve", "composite_curve", "bezier_curve", "b_spline_curve", "rational_b_spline_curve", "affine_transform_2d"],
    optionalCapabilities: ["layer", "line_style", "text", "hatch", "source_provenance", "dwg_semantics", "semantic_class"],
    acceptedCapabilityMajor: 1,
  },
  projections: [
    { id: "mercator", state: "conformant", baseline: true },
    { id: "globe", state: "experimental", baseline: false },
  ] as readonly ProjectionRow[],
  experimental: [{ id: "webgpu", supported: false, note: "not a supported target; v1 does not depend on it (ADR 0008)" }],
} as const;

export const UNSUPPORTED_ROWS: readonly UnsupportedRow[] = [
  { id: "U1", combination: "MapLibre outside the tested range", code: "unsupported_maplibre_version", outcome: "refuse at attach; the message names the tested range" },
  { id: "U2", combination: "no WebGL2 context", code: "webgl2_required", outcome: "refuse at attach; no canvas2D fallback" },
  { id: "U3", combination: "required PVec capability not implemented", code: "unsupported_required_capability", outcome: "refuse before any payload byte; a wrong major of a known capability uses the same code with detail.reason set to version" },
  { id: "U4", combination: "optional PVec capability not implemented", code: "degrade", outcome: "skip the blocks and list the capability in the bootstrap report" },
  { id: "U5", combination: "file needs a newer reader than 1.0.0", code: "reader-too-old", outcome: "refuse before any payload byte" },
  { id: "U6", combination: "WASM fetch or compile blocked", code: "wasm_unavailable", outcome: "onAdd rejects, one error event, MapLibre layers keep rendering, no TypeScript geometry fallback" },
  { id: "U7", combination: "projection other than mercator", code: "UnprovenProjectionError", outcome: "refuse at attach unless allowUnprovenProjection is set; results are then non-conformant" },
];

/** Lowest tested version up to (not including) the next major after the highest tested one. */
export function peerRange(c: { readonly maplibre: readonly { readonly version: string }[] } = COMPAT): string {
  const first = c.maplibre[0]!.version;
  const last = c.maplibre[c.maplibre.length - 1]!.version;
  return `>=${first} <${Number(last.split(".")[0]) + 1}.0.0`;
}
