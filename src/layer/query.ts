import type { EntityDraw } from "../decode/tier0";
import type { Bounds, LngLat, SourcePoint } from "../pick/index";
import { PVecError } from "../source/errors";
import type { Evaluator } from "../wasm/loader";
import { bindPacked } from "../wasm/packed";
import type { QueryEngine } from "./internal";

/** The module's exact geometry for the file, behind the two calls of libviprs/pvec#252. Entity ids are the decimal strings of the file's ids. */
export interface ExactQuery {
  /** Source units from the point to the entity's curve, NaN when the module has no answer. */
  distance(entityId: string, x: number, y: number): number;
  /** Whether the entity's curve meets the box. */
  touches(entityId: string, box: Bounds): boolean;
  /** Gives the file back to the module. */
  close(): void;
}

/** The inverse half of the layer's transform, read at the moment of each pick, so a new georeference is followed. */
export interface PickView {
  lngLatToSource(l: LngLat): SourcePoint;
  /** Source units under one CSS pixel at this location. */
  sourceUnitsPerCssPx(l: LngLat): number;
}

/** Opens the file in the module a second time, for the distance calls: the Tier 0 cursor frees its own handle when its walk ends. Null for a module without them. */
export function exactQueryOver(evaluator: Evaluator, bytes: Uint8Array): ExactQuery | null {
  const rt = bindPacked(evaluator);
  if (!rt.hasDistanceCalls) return null;
  const file = rt.open(bytes);
  if (file < 0) throw new PVecError("load_failed", `the evaluator refused the file (code ${file})`);
  let open = true;
  return {
    distance: (entityId, x, y) => rt.entityDistance(file, Number(entityId), x, y),
    touches: (entityId, b) => rt.entityTouchesBox(file, Number(entityId), b.minX, b.minY, b.maxX, b.maxY) === 1,
    close: () => {
      if (open) (open = false, rt.release(file));
    },
  };
}

export interface QueryInit {
  exact: ExactQuery;
  /** The Tier 0 draws: they say which entities there are and where, and each bound is widened by its declared error. */
  draws: readonly EntityDraw[];
  /** Source units of one pixel of the view the Tier 0 errors are declared in. */
  tier0Px: number;
  view(): PickView | undefined;
  generation(entityId: string): number;
  halfWidthPx(entityId: string): number;
  visible(entityId: string): boolean;
}

/**
 * The query engine of a layer whose Tier 0 decode is complete: every entity is in the index, candidates are the entities whose
 * bounds (widened by the error their preview was declared at) meet the search box, and the distance of a candidate is the module's
 * exact one. An entity hidden by the layer filter is not returned. Nothing here evaluates a curve.
 */
export function buildQueryEngine(o: QueryInit): QueryEngine {
  const bounds = new Map<string, Bounds>();
  const entries: Array<{ entityId: string; box: Bounds }> = [];
  for (const d of o.draws) {
    const pad = d.kind === "preview" ? d.declaredErrorPx * o.tier0Px : 0;
    const b = d.bounds;
    bounds.set(d.entityId, b);
    entries.push({ entityId: d.entityId, box: { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad } });
  }
  const meets = (a: Bounds, b: Bounds): boolean => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
  const view = (): PickView => o.view() ?? { lngLatToSource: () => ({ x: NaN, y: NaN }), sourceUnitsPerCssPx: () => NaN };
  return {
    pipeline: { lngLatToSource: (l) => view().lngLatToSource(l), sourceUnitsPerDevicePx: (l) => view().sourceUnitsPerCssPx(l) },
    index: {
      query: (b) => entries.filter((e) => meets(e.box, b)).map((e) => ({ entityId: e.entityId, entityType: "entity" })),
      isLoaded: () => true,
    },
    evaluator: {
      distance: (entityId, p) => o.exact.distance(entityId, p.x, p.y),
      intersects: (entityId, region) => {
        if (Array.isArray(region)) throw new PVecError("load_failed", "a polygon region is not supported: the module tests boxes");
        return o.exact.touches(entityId, region as Bounds);
      },
    },
    generation: o.generation,
    // a safety cap on the search box, in CSS pixels
    maxCandidateRadiusPx: 512,
    boundsOf: (entityId) => bounds.get(entityId) ?? { minX: NaN, minY: NaN, maxX: NaN, maxY: NaN },
    halfWidthPx: o.halfWidthPx,
    tier0Complete: () => true,
    quarantined: (entityId) => !o.visible(entityId),
  };
}
